/**
 * The in-pod finalize entrypoint (pl-829f step 20 / warren-0d35, design
 * `runtime-provider-contract.md` §4). Runs INSIDE the run pod as a post-agent
 * step — the K8s counterpart to `../local/finalize.ts`, which the burrow
 * `LocalProvider` runs host-side over the shared workspace.
 *
 * The lifecycle contract the agent image (step 25) wires around this:
 *
 *   1. the agent process runs and exits (having emitted its terminal event on
 *      the log stream, which is how warren detects logical completion and drives
 *      reap → `provider.finalize()` — independent of the pod phase);
 *   2. the harness invokes THIS entrypoint, which POLLS
 *      `GET /runs/:id/finalize-intent` until warren parks the reap intent;
 *   3. it runs the workspace-DEPENDENT collection in place (git push + the reap
 *      counts + the mirror-delta bodies) against the live `/workspace`;
 *   4. it POSTs a `FinalizeResult` to `POST /runs/:id/finalize-result`, which
 *      resolves the awaiting `finalize()`; the harness then exits and the domain
 *      calls `terminate` (contract §6.8 ordering).
 *
 * ## What this step builds vs. defers (be precise — step 25 proves the rest)
 *
 * BUILT: the pure collection — env parse, the authenticated push (+ commits-ahead
 * / empty-push / dirty probe faithful to reap's `pushStep`), the
 * `workspacePlansBody` capture auto-plan-run needs, and the mirror-delta BODIES
 * read straight off the workspace, all JSON-serialized onto the contract wire.
 *
 * DEFERRED to step 25's data-plane pass: the `chore(warren): seeds
 * state` bookkeeping commit and the true LWW MERGE COUNTS. Both need warren's
 * project clone to union against, which the pod does not have (design §4:
 * "warren applies the returned deltas to its project clone"). So the in-pod
 * deltas are WORKSPACE-TRUTH — `mergedBody` is the workspace tracker file
 * verbatim; the merge/count reconciliation + the bookkeeping commits happen
 * warren-side when it applies the deltas. `seeds_commit` is marked
 * `skipped` here for that reason.
 *
 * The push credential arrives IN the intent (`gitToken`) — fetched over the
 * authenticated callback after the agent exited — not the agent container's
 * static env, so a compromised agent never held it (`provider.ts` decision).
 */

import { readdir as nodeReaddir, readFile as nodeReadFile } from "node:fs/promises";
import {
	collectFinalizeResult,
	type FinalizeFs,
	type FinalizeGitRunner,
} from "./finalize-collect.ts";
import type { FinalizeResultEnvelope, InPodFinalizeIntent } from "./finalize-wire.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "./finalize-wire.ts";

/* -------------------------------------------------------------------------- */
/* Env                                                                        */
/* -------------------------------------------------------------------------- */

export interface FinalizeEntrypointEnv {
	runId: string;
	apiUrl: string;
	apiToken: string;
	workspacePath: string;
	/** Poll interval for the intent fetch (ms). */
	pollIntervalMs: number;
	/** Max wall-clock to wait for warren to park an intent before giving up (ms). */
	maxWaitMs: number;
	/**
	 * Max attempts for the result POST before giving up (warren-fd08). A transient
	 * "Unable to connect" / non-2xx must not silently lose the collected result —
	 * the reap deltas the pod computed are otherwise unrecoverable (warren then
	 * falls to its finalize timeout and terminalizes the run FAILED).
	 */
	postMaxAttempts: number;
	/** Base backoff between result-POST retries (ms); doubles each attempt. */
	postRetryBaseMs: number;
}

export type FinalizeEnvSource = Readonly<Record<string, string | undefined>>;

function required(env: FinalizeEnvSource, key: string): string {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") {
		throw new Error(`finalize-entrypoint: missing required env ${key}`);
	}
	return raw;
}

function positiveIntEnv(env: FinalizeEnvSource, key: string, fallback: number): number {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Parse + validate the finalize entrypoint env. Pure. */
export function parseFinalizeEntrypointEnv(env: FinalizeEnvSource): FinalizeEntrypointEnv {
	return {
		runId: required(env, "WARREN_RUN_ID"),
		apiUrl: required(env, "WARREN_API_URL").replace(/\/+$/, ""),
		apiToken: required(env, "WARREN_API_TOKEN"),
		workspacePath: env.WARREN_WORKSPACE_PATH?.trim() || "/workspace",
		pollIntervalMs: positiveIntEnv(env, "WARREN_FINALIZE_POLL_INTERVAL_MS", 2_000),
		maxWaitMs: positiveIntEnv(env, "WARREN_FINALIZE_MAX_WAIT_MS", 300_000),
		postMaxAttempts: positiveIntEnv(env, "WARREN_FINALIZE_POST_MAX_ATTEMPTS", 5),
		postRetryBaseMs: positiveIntEnv(env, "WARREN_FINALIZE_POST_RETRY_BASE_MS", 1_000),
	};
}

/* -------------------------------------------------------------------------- */
/* Injectable seams (testable without a cluster / real network)               */
/* -------------------------------------------------------------------------- */

export interface FinalizeHttp {
	get: (url: string, token: string) => Promise<{ status: number; body: unknown }>;
	post: (url: string, token: string, body: unknown) => Promise<{ status: number }>;
}

export interface FinalizeEntrypointDeps {
	git?: FinalizeGitRunner;
	fs?: FinalizeFs;
	http?: FinalizeHttp;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	log?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Poll + POST orchestration                                                  */
/* -------------------------------------------------------------------------- */

const defaultGit: FinalizeGitRunner = async (args, opts) => {
	const proc = Bun.spawn(["git", ...args], {
		cwd: opts?.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
};

const defaultFs: FinalizeFs = {
	readFile: (path) => nodeReadFile(path, "utf8"),
	readdir: (path) => nodeReaddir(path),
};

const defaultHttp: FinalizeHttp = {
	get: async (url, token) => {
		const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
		const body = res.status === 200 ? await res.json() : null;
		return { status: res.status, body };
	},
	post: async (url, token, body) => {
		const res = await fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status };
	},
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Extract the parked intent from a `GET /finalize-intent` body. `{ intent: null }`
 * (warren not driving finalize yet) ⇒ `null`; an intent object ⇒ it. Pure.
 */
export function extractIntent(body: unknown): InPodFinalizeIntent | null {
	if (body === null || typeof body !== "object") return null;
	const intent = (body as { intent?: unknown }).intent;
	if (intent === null || typeof intent !== "object") return null;
	return intent as InPodFinalizeIntent;
}

/**
 * Poll `GET /runs/:id/finalize-intent` until warren parks an intent or `maxWaitMs`
 * elapses. Returns the intent, or `null` on timeout (the harness then exits and
 * warren's own finalize timeout produces a failed result).
 */
export async function pollForIntent(
	env: FinalizeEntrypointEnv,
	http: FinalizeHttp,
	sleep: (ms: number) => Promise<void>,
	now: () => number,
	log: (m: string) => void,
): Promise<InPodFinalizeIntent | null> {
	const url = `${env.apiUrl}/runs/${env.runId}/finalize-intent`;
	const deadline = now() + env.maxWaitMs;
	for (;;) {
		// A thrown fetch ("Unable to connect") is a TRANSIENT poll miss, not a
		// finalize-killer: the first GET after the agent's long run can land on a
		// stale kept-alive socket (hit live on GKE, warren-4e36 — the entire
		// finalize died on poll #1 and every run reaped with "terminal phase
		// without posting a finalize result"). Same rationale as the result-POST
		// retry (warren-fd08): keep polling until the intent shows or the
		// deadline expires.
		let res: { status: number; body: unknown } | undefined;
		try {
			res = await http.get(url, env.apiToken);
		} catch (err) {
			log(
				`finalize-entrypoint: intent poll failed (${err instanceof Error ? err.message : String(err)}); retrying`,
			);
		}
		if (res !== undefined && res.status === 200) {
			const intent = extractIntent(res.body);
			if (intent !== null) return intent;
		}
		if (now() >= deadline) {
			log(`finalize-entrypoint: no intent after ${env.maxWaitMs}ms; giving up`);
			return null;
		}
		await sleep(env.pollIntervalMs);
	}
}

/** A result POST is delivered iff warren answers 2xx (its intake is idempotent). */
function postAccepted(status: number): boolean {
	return status >= 200 && status < 300;
}

/**
 * POST the result envelope with bounded retry + exponential backoff (warren-fd08).
 * A single transient "Unable to connect" (thrown by `fetch`) or a non-2xx answer
 * must not lose the collected reap deltas — warren's finalize intake is
 * idempotent (duplicate/stale/unknown all 200), so re-POSTing is always safe.
 * Returns whether the result was ultimately accepted; the caller logs either way
 * (a give-up leaves warren's own finalize timeout to terminalize the run).
 */
export async function postResultWithRetry(
	env: FinalizeEntrypointEnv,
	http: FinalizeHttp,
	sleep: (ms: number) => Promise<void>,
	log: (m: string) => void,
	url: string,
	envelope: FinalizeResultEnvelope,
): Promise<boolean> {
	let backoff = env.postRetryBaseMs;
	for (let attempt = 1; attempt <= env.postMaxAttempts; attempt += 1) {
		try {
			const res = await http.post(url, env.apiToken, envelope);
			if (postAccepted(res.status)) {
				if (attempt > 1) {
					log(`finalize-entrypoint: result POST succeeded on attempt ${attempt}`);
				}
				return true;
			}
			log(
				`finalize-entrypoint: result POST attempt ${attempt}/${env.postMaxAttempts} got HTTP ${res.status}`,
			);
		} catch (err) {
			log(
				`finalize-entrypoint: result POST attempt ${attempt}/${env.postMaxAttempts} failed (${err instanceof Error ? err.message : String(err)})`,
			);
		}
		if (attempt < env.postMaxAttempts) {
			await sleep(backoff);
			backoff *= 2;
		}
	}
	log(`finalize-entrypoint: result POST gave up after ${env.postMaxAttempts} attempts`);
	return false;
}

/**
 * Full entrypoint: poll for the intent, run the workspace collection, and POST
 * the `FinalizeResult`. Returns `true` when a result was POSTed, `false` when no
 * intent arrived (nothing to do). The workspace-touching seams are injectable so
 * the orchestration is testable without a cluster / real git / real network.
 */
export async function runFinalizeEntrypoint(
	envSource: FinalizeEnvSource,
	deps: FinalizeEntrypointDeps = {},
): Promise<boolean> {
	const git = deps.git ?? defaultGit;
	const fs = deps.fs ?? defaultFs;
	const http = deps.http ?? defaultHttp;
	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? ((m: string) => console.log(m));

	const env = parseFinalizeEntrypointEnv(envSource);
	const intent = await pollForIntent(env, http, sleep, now, log);
	if (intent === null) return false;

	log(`finalize-entrypoint: intent ${intent.attemptId} received; collecting`);
	const result = await collectFinalizeResult(intent, env.workspacePath, { fs, git });
	const envelope: FinalizeResultEnvelope = {
		version: IN_POD_FINALIZE_WIRE_VERSION,
		attemptId: intent.attemptId,
		result,
	};
	const url = `${env.apiUrl}/runs/${env.runId}/finalize-result`;
	const delivered = await postResultWithRetry(env, http, sleep, log, url, envelope);
	log(
		`finalize-entrypoint: result for ${intent.attemptId} delivered=${delivered} (pushed=${result.pushed})`,
	);
	return delivered;
}

if (import.meta.main) {
	runFinalizeEntrypoint(process.env).catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
