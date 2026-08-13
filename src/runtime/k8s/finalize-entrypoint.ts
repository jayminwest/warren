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
 * never held it (`provider.ts` decision). For the salvage windows an intent
 * never reaches, warren-c9ac routes the fallback through the SAME channel:
 * the harness POSTs `/runs/:id/git-credential` and warren mints a fresh
 * credential off the forge (forge-contract.md §4.1 — the pod cannot hold an
 * App private key, so it asks the control plane). The warren-6016
 * pod-carried `WARREN_GIT_TOKEN` (off the `warren-git-token` Secret) remains
 * only as the PAT-mode last resort for an unreachable control plane; the
 * agent child is still spawned with it scrubbed (`agent-io.ts`), so the
 * blast-radius posture is unchanged for the agent itself.
 */

import { readdir as nodeReaddir, readFile as nodeReadFile, rm as nodeRm } from "node:fs/promises";
import {
	collectFinalizeResult,
	type FinalizeFs,
	type FinalizeGitRunner,
} from "./finalize-collect.ts";
import type { FinalizeResultEnvelope, InPodFinalizeIntent } from "./finalize-wire.ts";
import { IN_POD_FINALIZE_WIRE_VERSION } from "./finalize-wire.ts";
import { salvageAndPost, salvageTriggerForResult } from "./salvage-post.ts";

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
	/**
	 * Pod-carried push credential (warren-6016) — `WARREN_GIT_TOKEN`, falling
	 * back to `GITHUB_TOKEN`. Sourced from the `warren-git-token` Secret on
	 * the agent container (or, under App mode, the token minted at pod-spec
	 * time — warren-c9ac) and held ONLY by this harness (the agent child
	 * spawns with it scrubbed — see `agent-io.ts`). It is the salvage window's
	 * LAST-RESORT credential: an intent-carried `gitToken` wins, then a
	 * credential freshly minted over the `POST /runs/:id/git-credential`
	 * callback (warren-c9ac); this one covers only the case where the control
	 * plane itself is unreachable in the `no_intent` window.
	 */
	gitToken: string | undefined;
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
	/**
	 * The AGENT process's exit code (warren-5202), overlaid onto the env by
	 * `agent-entrypoint` (`WARREN_AGENT_EXIT_CODE`) before this step runs.
	 * Reported on every intent poll as `?agent_exit=` so a recovering control
	 * plane can classify the run's outcome without the (possibly log-rotated)
	 * terminal envelope. `undefined` when the overlay is absent — e.g. a pod
	 * image predating the hint — and the recovery scan falls back to the
	 * persisted event log.
	 */
	agentExitCode: number | undefined;
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
		gitToken: env.WARREN_GIT_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined,
		pollIntervalMs: intEnv(env, "WARREN_FINALIZE_POLL_INTERVAL_MS", 2_000, 1),
		maxWaitMs: intEnv(env, "WARREN_FINALIZE_MAX_WAIT_MS", DEFAULT_FINALIZE_MAX_WAIT_MS, 1),
		earlySalvageMs: intEnv(env, "WARREN_FINALIZE_EARLY_SALVAGE_MS", 300_000, 0),
		salvageMaxWaitMs: intEnv(env, "WARREN_SALVAGE_MAX_WAIT_MS", 120_000, 1),
		postMaxAttempts: intEnv(env, "WARREN_FINALIZE_POST_MAX_ATTEMPTS", 5, 1),
		postRetryBaseMs: intEnv(env, "WARREN_FINALIZE_POST_RETRY_BASE_MS", 1_000, 1),
		agentExitCode: parseAgentExitCode(env.WARREN_AGENT_EXIT_CODE),
	};
}

/** Optional `WARREN_AGENT_EXIT_CODE` overlay (warren-5202): an integer 0-255, else absent. */
function parseAgentExitCode(raw: string | undefined): number | undefined {
	const trimmed = raw?.trim();
	if (trimmed === undefined || trimmed === "") return undefined;
	const n = Number(trimmed);
	return Number.isInteger(n) && n >= 0 && n <= 255 ? n : undefined;
}

/* -------------------------------------------------------------------------- */
/* Injectable seams (testable without a cluster / real network)               */
/* -------------------------------------------------------------------------- */

export interface FinalizeHttp {
	get: (url: string, token: string) => Promise<{ status: number; body: unknown }>;
	post: (url: string, token: string, body: unknown) => Promise<{ status: number; body?: unknown }>;
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
		// warren-6016: an `undefined` overlay value REMOVES the key (the
		// repo-context scrub a warren-authored commit spawns with).
		...(opts?.env !== undefined ? { env: applyGitEnvOverlay(opts.env) } : {}),
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

/**
 * Merge a git-spawn env overlay over the process env: defined values set,
 * `undefined` values delete (warren-6016). The overlay exists so a
 * warren-authored commit can pin its identity env AND scrub the inherited
 * `GIT_*` repo-context family (`src/bot-identity.ts`).
 */
function applyGitEnvOverlay(overlay: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(overlay)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

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
		return { status: res.status, body: await res.json().catch(() => null) };
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
	// warren-5202: report the agent's exit code on every poll so a recovered
	// control plane classifies the outcome from the pod's own witness instead
	// of the (possibly log-rotated) terminal envelope. Pre-hint control planes
	// ignore the unknown query param.
	const url =
		env.agentExitCode !== undefined
			? `${env.apiUrl}/runs/${env.runId}/finalize-intent?agent_exit=${env.agentExitCode}`
			: `${env.apiUrl}/runs/${env.runId}/finalize-intent`;
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
 * Full entrypoint: poll for the intent, run the workspace collection, and POST
 * the `FinalizeResult`. Returns `true` when a result was POSTed, `false` when no
 * intent arrived (nothing to do). The workspace-touching seams are injectable so
 * the orchestration is testable without a cluster / real git / real network.
 *
 * warren-cd3b: both loss windows run salvage BEFORE the process can exit —
 * no intent at all ⇒ bundle + retry through a rollout; a failed branch push
 * ⇒ rescue-ref + bundle BEFORE the result POST. warren-5ea1: and a proactive
 * bundle at the early-salvage mark, mid-wait. warren-985e: a third window —
 * a SUCCESSFUL push with zero commits ahead and a dirty tree (the run died
 * mid-work before its first commit) folds the dirty tree into a salvage
 * commit and captures it before the result POST.
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
	// Loss-window salvage (warren-cd3b, warren-985e) runs BEFORE the result
	// POST below resolves warren's awaiting finalize, which proceeds straight
	// to `terminate` (contract §6.8) — after it, this volume is gone. The
	// `empty_push_dirty` window is the warren-985e fix: the push can SUCCEED
	// and still carry nothing (the run died mid-work, e.g. provider_error
	// credit exhaustion, before its first commit), leaving the uncommitted
	// diff to die with the emptyDir unless the pod captures it here.
	const salvageTrigger = salvageTriggerForResult(result);
	if (salvageTrigger !== null) {
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
			salvageTrigger,
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
