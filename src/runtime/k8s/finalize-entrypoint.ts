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
 *      `GET /runs/:id/finalize-intent` until warren parks the reap intent.
 *      The wait outlasts warren's slowest intent-parking path (warren-5ea1),
 *      with a proactive salvage banked at the 5-min mark — the pod is the
 *      ONLY place the commits exist; exiting early loses work;
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
 * `workspacePlansBody` capture, and the mirror-delta BODIES read straight off
 * the workspace, all JSON-serialized onto the contract wire.
 *
 * DEFERRED to step 25's data-plane pass: the `chore(warren): seeds
 * state` bookkeeping commit and the true LWW MERGE COUNTS. Both need warren's
 * project clone to union against, which the pod does not have (design §4). So
 * the in-pod deltas are WORKSPACE-TRUTH — `mergedBody` is the workspace
 * tracker file verbatim; the merge/count reconciliation + the bookkeeping
 * commits happen warren-side when it applies the deltas. `seeds_commit` is
 * marked `skipped` here for that reason.
 *
 * The push credential arrives IN the intent (`gitToken`) — fetched over the
 * authenticated callback after the agent exited — so a compromised agent
 * never held it (`provider.ts` decision).
 */

import { readdir as nodeReaddir, readFile as nodeReadFile, rm as nodeRm } from "node:fs/promises";
import {
	collectFinalizeResult,
	type FinalizeFs,
	type FinalizeGitRunner,
} from "./finalize-collect.ts";
import type {
	FinalizeResultEnvelope,
	InPodFinalizeIntent,
	SalvageEnvelope,
} from "./finalize-wire.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "./finalize-wire.ts";
import { collectSalvage } from "./salvage.ts";

/* -------------------------------------------------------------------------- */
/* Env                                                                        */
/* -------------------------------------------------------------------------- */

export interface FinalizeEntrypointEnv {
	runId: string;
	apiUrl: string;
	apiToken: string;
	workspacePath: string;
	/** Base ref the run branch was cut from (WARREN_BASE_BRANCH); bundles the salvage range. */
	baseBranch: string | undefined;
	/** The run's own branch (WARREN_BRANCH); surfaced on the salvage envelope. */
	branch: string | undefined;
	/** Poll interval for the intent fetch (ms). */
	pollIntervalMs: number;
	/**
	 * Max wall-clock to wait for warren to park an intent before giving up
	 * (ms). warren-5ea1: 50 min — must OUTLAST warren's 45-min heartbeat
	 * watchdog, its slowest intent-parking path (the pod stays `Running`
	 * while this entrypoint waits).
	 */
	maxWaitMs: number;
	/** warren-5ea1: post a proactive `no_intent` salvage bundle once the wait
	 * crosses this mark (default 5 min), then keep waiting to `maxWaitMs`. */
	earlySalvageMs: number; // 0 disables
	/**
	 * Max wall-clock to keep retrying the SALVAGE post when no intent ever
	 * arrived (warren-cd3b): the pod must outlast a control-plane rollout long
	 * enough for the new control plane to intake the bundle. In the
	 * `push_failed` window the bounded result-POST budget applies instead.
	 */
	salvageMaxWaitMs: number;
	/**
	 * Max attempts for the result POST before giving up (warren-fd08): a
	 * transient connect error / non-2xx must not lose the collected deltas.
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

/** Integer env knob ≥ `min` (`0` when the knob has a disable sentinel), else `fallback`. */
function intEnv(env: FinalizeEnvSource, key: string, fallback: number, min: 0 | 1): number {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n >= min ? n : fallback;
}

/**
 * Default ceiling for the intent poll (warren-9d24): 40 minutes. Deliberately
 * below the heartbeat watchdog budget (`DEFAULT_WATCHDOG_HEARTBEAT_TIMEOUT_MS`,
 * 45 min) — a pod waiting on an intent is silent for the whole wait, so a
 * ceiling above the watchdog budget would let the watchdog terminalize the run
 * before the terminal `no_intent` salvage POST lands, and the run-scope gate
 * would then 401 every attempt. A cross-budget test pins this ordering.
 */
export const DEFAULT_FINALIZE_MAX_WAIT_MS = 2_400_000;

/** Parse + validate the finalize entrypoint env. Pure. */
export function parseFinalizeEntrypointEnv(env: FinalizeEnvSource): FinalizeEntrypointEnv {
	return {
		runId: required(env, "WARREN_RUN_ID"),
		apiUrl: required(env, "WARREN_API_URL").replace(/\/+$/, ""),
		apiToken: required(env, "WARREN_API_TOKEN"),
		workspacePath: env.WARREN_WORKSPACE_PATH?.trim() || "/workspace",
		baseBranch: env.WARREN_BASE_BRANCH?.trim() || undefined,
		branch: env.WARREN_BRANCH?.trim() || undefined,
		pollIntervalMs: intEnv(env, "WARREN_FINALIZE_POLL_INTERVAL_MS", 2_000, 1),
		maxWaitMs: intEnv(env, "WARREN_FINALIZE_MAX_WAIT_MS", DEFAULT_FINALIZE_MAX_WAIT_MS, 1),
		earlySalvageMs: intEnv(env, "WARREN_FINALIZE_EARLY_SALVAGE_MS", 300_000, 0),
		salvageMaxWaitMs: intEnv(env, "WARREN_SALVAGE_MAX_WAIT_MS", 120_000, 1),
		postMaxAttempts: intEnv(env, "WARREN_FINALIZE_POST_MAX_ATTEMPTS", 5, 1),
		postRetryBaseMs: intEnv(env, "WARREN_FINALIZE_POST_RETRY_BASE_MS", 1_000, 1),
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
	/** Salvage seams (warren-cd3b) — default to node fs; injected in tests. */
	readFileBytes?: (path: string) => Promise<Uint8Array>;
	rm?: (path: string) => Promise<void>;
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

const defaultReadFileBytes = async (path: string): Promise<Uint8Array> => nodeReadFile(path);

const defaultRm = async (path: string): Promise<void> => {
	await nodeRm(path, { force: true });
};

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
 * elapses; `null` on timeout (warren's own finalize timeout then produces a
 * failed result). `onEarlySalvage` fires once at the `earlySalvageMs` mark.
 */
export async function pollForIntent(
	env: FinalizeEntrypointEnv,
	http: FinalizeHttp,
	sleep: (ms: number) => Promise<void>,
	now: () => number,
	log: (m: string) => void,
	onEarlySalvage?: () => Promise<unknown>,
): Promise<InPodFinalizeIntent | null> {
	const url = `${env.apiUrl}/runs/${env.runId}/finalize-intent`;
	const startedAt = now();
	const deadline = startedAt + env.maxWaitMs;
	// warren-5ea1: `onEarlySalvage` fires ONCE at the `earlySalvageMs` mark.
	let earlySalvageDone = onEarlySalvage === undefined || env.earlySalvageMs <= 0;
	for (;;) {
		const intent = await fetchParkedIntent(env, http, url, log);
		if (intent !== null) return intent;
		if (!earlySalvageDone && now() - startedAt >= env.earlySalvageMs) {
			earlySalvageDone = true;
			log(`finalize-entrypoint: no intent after ${env.earlySalvageMs}ms; posting early salvage`);
			await onEarlySalvage?.();
		}
		if (now() >= deadline) {
			log(`finalize-entrypoint: no intent after ${env.maxWaitMs}ms; giving up`);
			return null;
		}
		await sleep(env.pollIntervalMs);
	}
}

/**
 * One intent poll; `null` when nothing is parked. A thrown fetch ("Unable to
 * connect") is a TRANSIENT miss, not a finalize-killer: the first GET after
 * the agent's long run can land on a stale kept-alive socket (hit live on
 * GKE, warren-4e36 — the entire finalize died on poll #1). Same rationale as
 * the result-POST retry (warren-fd08).
 */
async function fetchParkedIntent(
	env: FinalizeEntrypointEnv,
	http: FinalizeHttp,
	url: string,
	log: (m: string) => void,
): Promise<InPodFinalizeIntent | null> {
	let res: { status: number; body: unknown } | undefined;
	try {
		res = await http.get(url, env.apiToken);
	} catch (err) {
		log(
			`finalize-entrypoint: intent poll failed (${err instanceof Error ? err.message : String(err)}); retrying`,
		);
	}
	if (res === undefined || res.status !== 200) return null;
	return extractIntent(res.body);
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
 * Salvage-before-exit (warren-cd3b): capture the workspace's committed work
 * (rescue-ref push when a credential is available + a git bundle) and POST it
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
	env: FinalizeEntrypointEnv,
	http: FinalizeHttp,
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
	const salvage = await collectSalvage(
		{
			runId: env.runId,
			workspacePath: env.workspacePath,
			baseBranch: env.baseBranch,
			gitToken,
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
	const deadline = now() + (trigger === "no_intent" ? env.salvageMaxWaitMs : 0);
	// Bounded attempts when warren is reachable; wall-clock deadline otherwise.
	const exhausted = (attempt: number): boolean =>
		trigger === "push_failed" || bounded === true
			? attempt >= env.postMaxAttempts
			: now() >= deadline;
	let backoff = env.postRetryBaseMs;
	for (let attempt = 1; ; attempt += 1) {
		let accepted = false;
		try {
			accepted = postAccepted((await http.post(url, env.apiToken, envelope)).status);
		} catch (err) {
			log(
				`finalize-entrypoint: salvage POST attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)})`,
			);
		}
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

/**
 * Full entrypoint: poll for the intent, run the workspace collection, and POST
 * the `FinalizeResult`. Returns `true` when a result was POSTed, `false` when no
 * intent arrived (nothing to do). The workspace-touching seams are injectable so
 * the orchestration is testable without a cluster / real git / real network.
 *
 * warren-cd3b: both loss windows run salvage BEFORE the process can exit —
 * no intent at all ⇒ bundle + retry through a rollout; a failed branch push
 * ⇒ rescue-ref + bundle BEFORE the result POST. warren-5ea1: and a proactive
 * bundle at the early-salvage mark, mid-wait.
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
	const readFileBytes = deps.readFileBytes ?? defaultReadFileBytes;
	const rm = deps.rm ?? defaultRm;

	const env = parseFinalizeEntrypointEnv(envSource);
	// warren-5ea1: bank a bundle at the early-salvage mark while still waiting.
	const earlySalvage = (): Promise<boolean> =>
		salvageAndPost(
			env,
			http,
			sleep,
			now,
			log,
			"no_intent",
			undefined,
			git,
			readFileBytes,
			rm,
			true,
		);
	const intent = await pollForIntent(env, http, sleep, now, log, earlySalvage);
	if (intent === null) {
		// No reap intent ever arrived (warren lost track of this pod). Salvage
		// the emptyDir-only commits before exiting, retrying through a rollout.
		await salvageAndPost(
			env,
			http,
			sleep,
			now,
			log,
			"no_intent",
			undefined,
			git,
			readFileBytes,
			rm,
		);
		return false;
	}

	log(`finalize-entrypoint: intent ${intent.attemptId} received; collecting`);
	const result = await collectFinalizeResult(intent, env.workspacePath, { fs, git });
	// The primary push failed (timeout / push protection / auth). Salvage FIRST:
	// the result POST below resolves warren's awaiting finalize, which proceeds
	// straight to `terminate` (contract §6.8) — after it, this volume is gone.
	const pushFailed = result.stages.some((s) => s.stage === "branch_push" && s.status === "failed");
	if (pushFailed) {
		// The intent's baseBranch narrows the bundle range; the env carries the
		// pod-spec copy for the salvage envelope's bookkeeping fields.
		const salvageEnv: FinalizeEntrypointEnv =
			intent.baseBranch !== undefined && intent.baseBranch !== ""
				? { ...env, baseBranch: intent.baseBranch }
				: env;
		await salvageAndPost(
			salvageEnv,
			http,
			sleep,
			now,
			log,
			"push_failed",
			intent.gitToken,
			git,
			readFileBytes,
			rm,
		);
	}
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
