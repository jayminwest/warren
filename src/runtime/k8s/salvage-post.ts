/**
 * The salvage POST orchestration (warren-cd3b), split out of
 * `./finalize-entrypoint.ts` so that file stays under the file-size budget:
 * run the in-pod capture (`./salvage.ts`), wrap it in a `SalvageEnvelope`, and
 * POST it to `POST /runs/:id/salvage` with the retry budget matching the
 * window it rode in on. Pure over the same injectable seams as the entrypoint,
 * so it is unit-testable without a cluster or a real repo.
 */

import type { FinalizeGitRunner } from "./finalize-collect.ts";
import type { SalvageEnvelope } from "./finalize-wire.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "./finalize-wire.ts";
import { collectSalvage } from "./salvage.ts";

/**
 * The slice of the finalize entrypoint env the salvage POST needs. Structural
 * (a `FinalizeEntrypointEnv` is a superset) so this module stays off the
 * entrypoint's type graph.
 */
export interface SalvagePostEnv {
	readonly runId: string;
	readonly apiUrl: string;
	readonly apiToken: string;
	readonly workspacePath: string;
	readonly baseBranch: string | undefined;
	readonly branch: string | undefined;
	/** Pod-carried push credential (warren-6016) — the no_intent fallback. */
	readonly gitToken: string | undefined;
	readonly salvageMaxWaitMs: number;
	readonly postMaxAttempts: number;
	readonly postRetryBaseMs: number;
}

/** The POST half of the entrypoint's `FinalizeHttp` seam. */
export interface SalvagePostHttp {
	post: (url: string, token: string, body: unknown) => Promise<{ status: number }>;
}

/**
 * Salvage-before-exit (warren-cd3b): capture the workspace's work (a dirty
 * tree is folded into a warren bookkeeping commit first — warren-6016; then a
 * rescue-ref push when a credential is available + a git bundle) and POST it
 * to `POST /runs/:id/salvage` BEFORE the container exits and the `emptyDir`
 * dies with it. Retried until `deadlineMs` of wall-clock budget is spent — in
 * the `no_intent` window that budget (`salvageMaxWaitMs`) is sized to outlast
 * a control-plane rollout; in the `push_failed` window warren is demonstrably
 * reachable so the standard bounded retry applies. `bounded` forces that
 * bounded-attempt budget for a `no_intent` post too (the warren-5ea1 EARLY
 * salvage, which must not stall the intent poll). Best-effort: never throws,
 * so a salvage failure can never mask the finalize path it rode in on.
 */
export async function salvageAndPost(
	env: SalvagePostEnv,
	http: SalvagePostHttp,
	sleep: (ms: number) => Promise<void>,
	now: () => number,
	log: (m: string) => void,
	trigger: SalvageEnvelope["trigger"],
	gitToken: string | undefined,
	git: FinalizeGitRunner,
	readFileBytes: (path: string) => Promise<Uint8Array>,
	rm: (path: string) => Promise<void>,
	bounded?: boolean,
): Promise<boolean> {
	// warren-6016: the intent's short-lived token wins; the pod-carried
	// `WARREN_GIT_TOKEN` covers the no_intent windows (no intent ever parked
	// one). Both resolve the same operator credential the reap push uses.
	const salvage = await collectSalvage(
		{
			runId: env.runId,
			workspacePath: env.workspacePath,
			baseBranch: env.baseBranch,
			gitToken: gitToken ?? env.gitToken,
		},
		{ git, readFileBytes, rm },
	);
	if (salvage.rescueRef === null && salvage.bundleBase64 === null) {
		log(`finalize-entrypoint: salvage (${trigger}) captured nothing: ${salvage.notes.join("; ")}`);
	}
	const envelope: SalvageEnvelope = {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		trigger,
		rescueRef: salvage.rescueRef,
		bundleBase64: salvage.bundleBase64,
		branch: env.branch ?? null,
		baseBranch: env.baseBranch ?? null,
		notes: salvage.notes,
	};
	const url = `${env.apiUrl}/runs/${env.runId}/salvage`;
	return postSalvageWithRetry(env, http, sleep, now, log, trigger, url, envelope, salvage, bounded);
}

/**
 * POST the envelope with the retry budget matching the window: bounded
 * attempts when warren is demonstrably reachable (`push_failed`, or the
 * warren-5ea1 early salvage that must not stall the intent poll); a
 * wall-clock deadline sized to outlast a control-plane rollout otherwise.
 */
async function postSalvageWithRetry(
	env: SalvagePostEnv,
	http: SalvagePostHttp,
	sleep: (ms: number) => Promise<void>,
	now: () => number,
	log: (m: string) => void,
	trigger: SalvageEnvelope["trigger"],
	url: string,
	envelope: SalvageEnvelope,
	salvage: { rescueRef: string | null; bundleBase64: string | null },
	bounded?: boolean,
): Promise<boolean> {
	const deadline = now() + (trigger === "no_intent" ? env.salvageMaxWaitMs : 0);
	const exhausted = (attempt: number): boolean =>
		trigger === "push_failed" || bounded === true
			? attempt >= env.postMaxAttempts
			: now() >= deadline;
	let backoff = env.postRetryBaseMs;
	for (let attempt = 1; ; attempt += 1) {
		const accepted = await postOnce(http, url, env.apiToken, envelope, attempt, log);
		if (accepted) {
			log(
				`finalize-entrypoint: salvage (${trigger}) delivered on attempt ${attempt} (rescueRef=${salvage.rescueRef}, bundle=${salvage.bundleBase64 !== null})`,
			);
			return true;
		}
		if (exhausted(attempt)) break;
		await sleep(backoff);
		backoff *= 2;
	}
	log(`finalize-entrypoint: salvage (${trigger}) POST gave up; work may be unrecoverable`);
	return false;
}

/** One POST attempt; a thrown connect error is a non-acceptance, never a throw. */
async function postOnce(
	http: SalvagePostHttp,
	url: string,
	token: string,
	envelope: SalvageEnvelope,
	attempt: number,
	log: (m: string) => void,
): Promise<boolean> {
	try {
		const res = await http.post(url, token, envelope);
		return res.status >= 200 && res.status < 300;
	} catch (err) {
		log(
			`finalize-entrypoint: salvage POST attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)})`,
		);
		return false;
	}
}
