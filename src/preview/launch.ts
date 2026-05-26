/**
 * `launchPreview` — spawn `preview.command` as a long-lived burrow sidecar
 * after a successful agent run, drive its readiness probe, and persist the
 * resulting `preview_state` (R-19 / SPEC §11.L, warren-f156).
 *
 * The actual orchestration (gating on outcome / opt-in / worker locality)
 * lives in `src/runs/reap.ts`; this module owns the mechanics once those
 * gates pass:
 *
 *   1. **Allocate** a host port via `PreviewPortAllocator`. The allocator
 *      writes `preview_state='starting'` + `preview_port` atomically; if
 *      the range is exhausted, we surface that as a typed result and never
 *      touch burrow.
 *   2. **Spawn** the sidecar via `POST /burrows/:id/sidecars` with the
 *      configured `command` (run through `sh -c` so shell forms like
 *      `bun run dev` work without per-call argv-splitting) and the
 *      `inboundPortForward: { hostPort, sandboxPort: previewConfig.port }`
 *      so burrow opens the loopback bridge between the host port and the
 *      in-sandbox listener.
 *   3. **Probe** readiness from the warren-host side. Burrow's sidecar
 *      registry marks the sidecar `live` the moment the process is
 *      spawned, but the SPEC's `live` state means "readiness probe returned
 *      2xx" — that's a higher bar than "process didn't crash on startup".
 *      We poll `http://127.0.0.1:<hostPort><readiness_path or '/'>` until a
 *      2xx response, the timeout fires, or the sidecar exits early. The
 *      probe uses GET and treats any 2xx as ready.
 *   4. **Persist** the outcome via `RunsRepo.attachPreview`. `live`
 *      leaves `preview_port` set and clears `preview_failure_message`;
 *      `failed` populates `preview_failure_message` with the stderr tail
 *      and clears `preview_port` so the allocator can recycle the port.
 *      Failure cleanup also calls `sidecars.delete` best-effort so the
 *      process doesn't linger past the failure transition.
 *
 * Every observable side effect (port allocator, burrow client, readiness
 * fetch, clock, sleep) is injectable so unit tests don't touch real
 * sockets or wait on real timers.
 *
 * Result shape is a discriminated union — callers (reap) map each branch
 * onto a structured `reap_failed` event. Cancellation (manual teardown,
 * eviction worker) and TTLs are explicitly **out of scope here**; this
 * module only owns the starting → {live, failed} transition.
 */

import type { Repos } from "../db/repos/index.ts";
import {
	DEFAULT_PREVIEW_MODE,
	type PreviewMode,
	PreviewModeSchema,
	type ServerPreviewConfig,
} from "../warren-config/index.ts";
import { PORT_EXHAUSTED_REASON, type PreviewPortAllocator } from "./port-allocator.ts";

/* ----------------------------------------------------------------------- */
/* Public surface                                                           */
/* ----------------------------------------------------------------------- */

export interface PreviewSidecarsClient {
	create(input: {
		readonly burrowId: string;
		readonly command: readonly string[];
		readonly env?: Record<string, string>;
		readonly cwd?: string;
		readonly inboundPortForward?: { hostPort: number; sandboxPort: number };
		readonly readinessPath?: string;
	}): Promise<{ readonly id: string; readonly state: string }>;
	logs(
		burrowId: string,
		sidecarId: string,
		opts?: { tailBytes?: number },
	): Promise<{ readonly stdout: string; readonly stderr: string }>;
	delete(burrowId: string, sidecarId: string): Promise<void>;
	/**
	 * Observe sidecar lifecycle state (warren-d9e7). Used by the setup
	 * pre-step to poll for completion before the dev-server sidecar
	 * spawns. Mirrors `GET /burrows/:id/sidecars/:sidecarId` over the
	 * facade; warren must not talk to the burrow socket directly
	 * (CLAUDE.md "Relationship to burrow").
	 */
	get(
		burrowId: string,
		sidecarId: string,
	): Promise<{ readonly state: string; readonly exitCode: number | null }>;
}

export interface LaunchPreviewInput {
	readonly runId: string;
	readonly burrowId: string;
	readonly previewConfig: ServerPreviewConfig;
	readonly repos: Repos;
	readonly allocator: PreviewPortAllocator;
	readonly sidecars: PreviewSidecarsClient;
	readonly now?: () => Date;
	/** Override the readiness-probe HTTP fetch (tests). */
	readonly fetch?: typeof fetch;
	/** Override sleeping between probe attempts (tests). */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Cap the readiness probe loop. Defaults to `DEFAULT_READINESS_TIMEOUT_MS`. */
	readonly readinessTimeoutMs?: number;
	/**
	 * Cap on phase 1 of the probe loop — "did anything bind on the port?"
	 * (warren-9b15). Defaults to `DEFAULT_CONNECT_TIMEOUT_MS`. Phase 2's
	 * `readinessTimeoutMs` deadline starts only after a successful TCP
	 * connect, so sidecar startup variance no longer steals from the
	 * bundler budget.
	 */
	readonly connectTimeoutMs?: number;
	/** Pause between probe attempts. Defaults to `DEFAULT_READINESS_POLL_MS`. */
	readinessPollMs?: number;
	/** Per-call AbortController timeout. Defaults to `PROBE_PER_CALL_TIMEOUT_MS`. */
	readonly probePerCallTimeoutMs?: number;
	/**
	 * Cap on the setup pre-step (warren-d9e7). Applied only when
	 * `previewConfig.setup` is set. Defaults to `DEFAULT_SETUP_TIMEOUT_MS`.
	 */
	readonly setupTimeoutMs?: number;
	/** Pause between setup status polls. Defaults to `DEFAULT_SETUP_POLL_MS`. */
	readonly setupPollMs?: number;
}

export type LaunchPreviewResult =
	| {
			readonly ok: true;
			readonly port: number;
			readonly sidecarId: string;
	  }
	| {
			readonly ok: false;
			readonly reason: LaunchFailureReason;
			readonly message: string;
			/** Stderr tail captured from the sidecar (best-effort), if any. */
			readonly failureTail: string;
			/** Port the allocator claimed before the launch failed (released by us). */
			readonly port: number | null;
	  };

export type LaunchFailureReason =
	| "port_exhausted"
	| "create_failed"
	| "connect_timeout"
	| "readiness_timeout"
	| "sidecar_exited"
	| "setup_failed"
	| "setup_timeout";

/**
 * Default readiness probe wall clock. Sized for the *bundler*, not for install
 * + bind: warren-d9e7 split install into its own setup sidecar, and warren-9b15
 * further split sidecar startup + port bind into its own `connect_timeout`
 * phase. What remains under this budget is first-route compile / SSR — modern
 * SPAs (Next.js, Vite, SvelteKit, Astro) routinely take 3-7 minutes for a cold
 * first-compile of a moderately large app — run `run_428nktsej0yh` on
 * jayminwest.com (Next.js 14, 1875 modules) finished its first compile at
 * ~10 min wall clock once the install was factored out (warren-fdf2). 10m
 * gives an honest budget; the probe returns on first 2xx so the happy path
 * is unaffected. Override per-project via `.warren/preview.yaml`'s
 * `readiness_timeout`.
 *
 * Post-warren-9b15 the deadline starts at the first successful TCP connect
 * (phase transition), not at sidecar create. Sidecar startup overhead lives
 * under `connect_timeout` instead.
 */
export const DEFAULT_READINESS_TIMEOUT_MS = 600_000;
/**
 * Default phase-1 ("did anything bind on the port?") deadline (warren-9b15).
 * Covers shell pre-exec, dev-server CLI startup, dependency import graph,
 * and port bind — i.e. sidecar startup variance, not bundler work. Sized at
 * 5m so a slow burrow / cold image / large dev-server import graph fails
 * fast with a distinct `connect_timeout` reason instead of degrading into
 * `readiness_timeout`. Override per-project via `.warren/preview.yaml`'s
 * `connect_timeout`.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 300_000;
/** Default pause between probe attempts. */
export const DEFAULT_READINESS_POLL_MS = 500;
/**
 * Default cap on the setup pre-step (warren-d9e7). Sized to cover a cold
 * pnpm/npm install for projects with hundreds of deps; tunable per-project
 * via `.warren/preview.yaml`'s `setup_timeout`.
 */
export const DEFAULT_SETUP_TIMEOUT_MS = 300_000;
/**
 * Default pause between setup-status polls. Setup commands typically run
 * for seconds-to-minutes, so 1s strikes a balance between staleness and
 * unix-socket chatter. Tighter polling buys no useful latency at
 * setup-step granularity; looser polling delays failure reporting.
 */
export const DEFAULT_SETUP_POLL_MS = 1_000;
/**
 * Per-call probe timeout (warren-33eb). The outer `readinessTimeoutMs` is a
 * wall-clock bound on the loop *between* attempts; without a per-call
 * timeout a single hung `fetch()` (e.g. burrow forwarder accepted the TCP
 * connection but the dev server is mid-compile and never flushes bytes)
 * blocks the deadline check indefinitely. 2s is a conservative upper bound —
 * a dev server that can't return any byte for `GET /` within 2s is not
 * "ready" in the §11.L sense even if it's alive.
 */
export const PROBE_PER_CALL_TIMEOUT_MS = 2_000;
/** Stderr tail size copied into `preview_failure_message`. */
export const PREVIEW_FAILURE_TAIL_BYTES = 4096;

/**
 * Default env block injected into every preview sidecar (warren-79b2).
 * Burrow's inbound forwarder connects via `nc 127.0.0.1 <sandboxPort>` from
 * inside the sandbox netns, so a dev server bound to `localhost`/`::1` only
 * (Next.js 13.5+ default) is unreachable. CRA reads `HOST`; several
 * Express-style servers read `HOST`/`HOSTNAME`; forcing both to `0.0.0.0`
 * is a no-op for projects already binding to all interfaces. `PORT` lets
 * Vite/Next.js/Express/CRA avoid hard-coding the sandbox port twice.
 *
 * Next.js's CLI silently IGNORES `HOSTNAME`/`HOST` env vars (its commander
 * `-H, --hostname` is NOT chained with `.env(...)`); Next.js projects must
 * still pass `-H 0.0.0.0` in their `command:`. The framework matrix in
 * `.warren/preview.yaml` documents this. Project commands override these
 * defaults by inlining `HOST=...` / `PORT=...` ahead of the command (sh -c).
 */
function defaultSidecarEnv(sandboxPort: number): Record<string, string> {
	return {
		HOST: "0.0.0.0",
		HOSTNAME: "0.0.0.0",
		PORT: String(sandboxPort),
	};
}

/* ----------------------------------------------------------------------- */
/* Implementation                                                           */
/* ----------------------------------------------------------------------- */

export async function launchPreview(input: LaunchPreviewInput): Promise<LaunchPreviewResult> {
	const now = input.now ?? (() => new Date());
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const sleep = input.sleep ?? defaultSleep;
	const timeoutMs = input.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const pollMs = input.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
	const perCallTimeoutMs = input.probePerCallTimeoutMs ?? PROBE_PER_CALL_TIMEOUT_MS;
	const setupTimeoutMs = input.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
	const setupPollMs = input.setupPollMs ?? DEFAULT_SETUP_POLL_MS;

	const allocation = await input.allocator.allocate(input.runId, now());
	if (allocation.status === "exhausted") {
		const message = `preview port range exhausted (reason=${PORT_EXHAUSTED_REASON})`;
		await input.repos.runs.attachPreview(input.runId, {
			previewState: "failed",
			previewFailureMessage: message,
		});
		return { ok: false, reason: "port_exhausted", message, failureTail: "", port: null };
	}
	const port = allocation.port;

	// warren-d9e7: setup pre-step. Runs to completion (no inbound forward) so
	// dependency install fails fast and surfaces a distinct failure reason
	// instead of degrading into readiness_timeout. Skipped when no setup
	// command is configured — existing single-command projects keep working.
	if (input.previewConfig.setup !== undefined) {
		const setupResult = await runSetupStep({
			input,
			now,
			sleep,
			setupCommand: input.previewConfig.setup,
			setupTimeoutMs,
			setupPollMs,
		});
		if (!setupResult.ok) {
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "failed",
				previewPort: null,
				previewFailureMessage: composeFailureMessage(setupResult.message, setupResult.failureTail),
			});
			return { ...setupResult, port };
		}
	}

	let sidecarId: string;
	try {
		const created = await input.sidecars.create({
			burrowId: input.burrowId,
			command: ["sh", "-c", input.previewConfig.command],
			env: defaultSidecarEnv(input.previewConfig.port),
			inboundPortForward: { hostPort: port, sandboxPort: input.previewConfig.port },
			...(input.previewConfig.readiness_path !== undefined
				? { readinessPath: input.previewConfig.readiness_path }
				: {}),
		});
		sidecarId = created.id;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await input.repos.runs.attachPreview(input.runId, {
			previewState: "failed",
			previewPort: null,
			previewFailureMessage: `sidecar create failed: ${truncate(message, PREVIEW_FAILURE_TAIL_BYTES)}`,
		});
		return {
			ok: false,
			reason: "create_failed",
			message,
			failureTail: "",
			port,
		};
	}

	const readinessPath = input.previewConfig.readiness_path ?? "/";
	const probeUrl = `http://127.0.0.1:${port}${readinessPath}`;

	// warren-9b15: two-phase probe loop. Phase 1 ("connect") waits for the
	// sidecar's listener to accept TCP — any HTTP response, even 4xx/5xx,
	// proves the port bound. Phase 2 ("readiness") then waits for 2xx/3xx
	// with its own wall clock, starting at the phase transition. Splitting
	// the budget means a slow burrow / cold image / shell pre-exec hang
	// surfaces as `connect_timeout` and stops eating the bundler budget.
	const connectDeadline = now().getTime() + connectTimeoutMs;
	while (true) {
		const probe = await probeOnce(fetchImpl, probeUrl, perCallTimeoutMs);
		if (probe === "ready") {
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "live",
				previewLastHitAt: now().toISOString(),
				previewFailureMessage: null,
			});
			return { ok: true, port, sidecarId };
		}
		if (probe === "http_response") {
			// Phase 1 → phase 2: port bound but didn't yet return 2xx/3xx.
			break;
		}
		// probe === "not_connected" → keep waiting under the connect budget.
		if (now().getTime() >= connectDeadline) {
			const failureTail = await captureFailureTail(input.sidecars, input.burrowId, sidecarId);
			await safeDeleteSidecar(input.sidecars, input.burrowId, sidecarId);
			const message = `phase=connect: preview port did not accept a TCP connection within ${connectTimeoutMs}ms (probed ${probeUrl})`;
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "failed",
				previewPort: null,
				previewFailureMessage: composeFailureMessage(message, failureTail),
			});
			return {
				ok: false,
				reason: "connect_timeout",
				message,
				failureTail,
				port,
			};
		}
		await sleep(pollMs);
	}

	const readinessDeadline = now().getTime() + timeoutMs;
	while (true) {
		const probe = await probeOnce(fetchImpl, probeUrl, perCallTimeoutMs);
		if (probe === "ready") {
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "live",
				previewLastHitAt: now().toISOString(),
				previewFailureMessage: null,
			});
			return { ok: true, port, sidecarId };
		}
		// In phase 2 both "http_response" and "not_connected" mean "not ready
		// yet" — the latter can legitimately happen if the dev server briefly
		// disconnects mid-restart (e.g. HMR rebuilds). We keep probing under
		// the readiness budget either way.
		if (now().getTime() >= readinessDeadline) {
			const failureTail = await captureFailureTail(input.sidecars, input.burrowId, sidecarId);
			await safeDeleteSidecar(input.sidecars, input.burrowId, sidecarId);
			const message = `phase=readiness: readiness probe did not return 2xx within ${timeoutMs}ms (probed ${probeUrl})`;
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "failed",
				previewPort: null,
				previewFailureMessage: composeFailureMessage(message, failureTail),
			});
			return {
				ok: false,
				reason: "readiness_timeout",
				message,
				failureTail,
				port,
			};
		}
		await sleep(pollMs);
	}
}

interface SetupStepFailure {
	readonly ok: false;
	readonly reason: "setup_failed" | "setup_timeout";
	readonly message: string;
	readonly failureTail: string;
}

async function runSetupStep(args: {
	input: LaunchPreviewInput;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	setupCommand: string;
	setupTimeoutMs: number;
	setupPollMs: number;
}): Promise<{ readonly ok: true } | SetupStepFailure> {
	const { input, now, sleep, setupCommand, setupTimeoutMs, setupPollMs } = args;
	let setupSidecarId: string;
	try {
		const created = await input.sidecars.create({
			burrowId: input.burrowId,
			command: ["sh", "-c", setupCommand],
		});
		setupSidecarId = created.id;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			reason: "setup_failed",
			message: `setup spawn failed: ${truncate(message, PREVIEW_FAILURE_TAIL_BYTES)}`,
			failureTail: "",
		};
	}

	const deadline = now().getTime() + setupTimeoutMs;
	while (true) {
		let status: { state: string; exitCode: number | null };
		try {
			status = await input.sidecars.get(input.burrowId, setupSidecarId);
		} catch {
			// Transient status-poll failure: don't fail the setup over a single
			// dropped query. Sleep and try again until the wall clock catches up.
			if (now().getTime() >= deadline) {
				const failureTail = await captureFailureTail(
					input.sidecars,
					input.burrowId,
					setupSidecarId,
				);
				await safeDeleteSidecar(input.sidecars, input.burrowId, setupSidecarId);
				return {
					ok: false,
					reason: "setup_timeout",
					message: `setup did not exit within ${setupTimeoutMs}ms`,
					failureTail,
				};
			}
			await sleep(setupPollMs);
			continue;
		}

		if (status.state === "exited") {
			if (status.exitCode === 0) {
				// Best-effort cleanup of the completed setup sidecar — burrow's
				// registry would garbage-collect it eventually, but explicit
				// removal keeps `GET /burrows/:id/sidecars` lists short.
				await safeDeleteSidecar(input.sidecars, input.burrowId, setupSidecarId);
				return { ok: true };
			}
			const failureTail = await captureFailureTail(input.sidecars, input.burrowId, setupSidecarId);
			await safeDeleteSidecar(input.sidecars, input.burrowId, setupSidecarId);
			return {
				ok: false,
				reason: "setup_failed",
				message: `setup exited with code ${status.exitCode}`,
				failureTail,
			};
		}

		if (now().getTime() >= deadline) {
			const failureTail = await captureFailureTail(input.sidecars, input.burrowId, setupSidecarId);
			await safeDeleteSidecar(input.sidecars, input.burrowId, setupSidecarId);
			return {
				ok: false,
				reason: "setup_timeout",
				message: `setup did not exit within ${setupTimeoutMs}ms`,
				failureTail,
			};
		}
		await sleep(setupPollMs);
	}
}

/**
 * Tri-state probe outcome (warren-9b15):
 *
 * - `ready`          → 2xx/3xx response. Launch succeeds.
 * - `http_response`  → connected and got a non-2xx/3xx HTTP response
 *                      (e.g. 4xx/5xx while bundler still compiles). Used
 *                      as the phase-1 → phase-2 discriminator.
 * - `not_connected`  → no HTTP response at all (ECONNREFUSED, EHOSTUNREACH,
 *                      AbortController fired before connect completed).
 *                      Keeps the loop in phase 1 under the connect budget.
 *
 * Bun's `fetch()` throws on transport-level failures (refused TCP, DNS,
 * abort) and resolves with a `Response` once headers are in — so the
 * presence of a `Response` object is a reliable "TCP connected + at
 * least some HTTP bytes flowed" signal. We can't perfectly distinguish
 * "bound but hung mid-headers + abort" from "never connected + abort"
 * inside the catch arm; treating that case as `not_connected` is the
 * conservative choice (it keeps the loop in phase 1, which has the
 * larger combined budget for slow-binding servers).
 */
type ProbeOutcome = "ready" | "http_response" | "not_connected";

async function probeOnce(
	fetchImpl: typeof fetch,
	url: string,
	perCallTimeoutMs: number,
): Promise<ProbeOutcome> {
	const ac = new AbortController();
	const tid = setTimeout(() => ac.abort(), perCallTimeoutMs);
	try {
		const res = await fetchImpl(url, {
			method: "GET",
			redirect: "manual",
			signal: ac.signal,
		});
		// 2xx ⇒ ready. 3xx is treated as ready too: a dev server that redirects
		// "/" → "/index" is ready; the proxy will follow on real traffic.
		if (res.ok || (res.status >= 300 && res.status < 400)) {
			await drainBody(res);
			return "ready";
		}
		await drainBody(res);
		return "http_response";
	} catch {
		return "not_connected";
	} finally {
		clearTimeout(tid);
	}
}

/**
 * Phase-1 TCP-only probe (warren-49d9 / pl-592f step 1).
 *
 * Phase 1 of `attemptPreviewLaunch` only needs to answer one question:
 * **is anything bound on the host port yet?** `probeOnce` answers a
 * stricter question (did the server send HTTP headers in time?) which
 * misclassifies slow-first-headers dev servers (e.g. Next.js mid-compile)
 * as `not_connected` and burns the connect budget. `tcpConnectOnce` opens
 * a raw TCP socket via `Bun.connect` and resolves as soon as the kernel
 * reports the connection established (or refused / unreachable / timed
 * out), without doing any HTTP work. The socket is closed immediately.
 *
 * Returns:
 *   - `connected`     → kernel accepted the TCP handshake; port is bound.
 *   - `not_connected` → refused, unreachable, or `timeoutMs` elapsed
 *                       before the handshake completed.
 */
export async function tcpConnectOnce(
	host: string,
	port: number,
	timeoutMs: number,
): Promise<"connected" | "not_connected"> {
	return new Promise<"connected" | "not_connected">((resolve) => {
		let settled = false;
		let tid: ReturnType<typeof setTimeout> | undefined;
		let socket: { end: () => void } | undefined;

		const finish = (outcome: "connected" | "not_connected"): void => {
			if (settled) return;
			settled = true;
			if (tid !== undefined) clearTimeout(tid);
			try {
				socket?.end();
			} catch {
				// socket may already be closed; ignore.
			}
			resolve(outcome);
		};

		tid = setTimeout(() => finish("not_connected"), timeoutMs);

		Bun.connect({
			hostname: host,
			port,
			socket: {
				open(sock) {
					socket = sock;
					finish("connected");
				},
				close() {},
				data() {},
				error() {
					finish("not_connected");
				},
			},
		}).catch(() => {
			finish("not_connected");
		});
	});
}

async function drainBody(res: Response): Promise<void> {
	try {
		await res.body?.cancel();
	} catch {
		// stream may already be closed; ignore.
	}
}

async function captureFailureTail(
	sidecars: PreviewSidecarsClient,
	burrowId: string,
	sidecarId: string,
): Promise<string> {
	try {
		const logs = await sidecars.logs(burrowId, sidecarId, {
			tailBytes: PREVIEW_FAILURE_TAIL_BYTES,
		});
		const tail = logs.stderr.trim() !== "" ? logs.stderr : logs.stdout;
		return truncate(tail, PREVIEW_FAILURE_TAIL_BYTES);
	} catch {
		return "";
	}
}

async function safeDeleteSidecar(
	sidecars: PreviewSidecarsClient,
	burrowId: string,
	sidecarId: string,
): Promise<void> {
	try {
		await sidecars.delete(burrowId, sidecarId);
	} catch {
		// Best-effort cleanup — eviction worker also terminates lingering sidecars.
	}
}

function composeFailureMessage(headline: string, tail: string): string {
	if (tail === "") return headline;
	return `${headline}\n\n${tail}`;
}

function truncate(input: string, max: number): string {
	if (input.length <= max) return input;
	return `${input.slice(input.length - max)}`;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ----------------------------------------------------------------------- */
/* Env-driven config (preview launch host for PR annotation)                */
/* ----------------------------------------------------------------------- */

export const WARREN_PREVIEW_HOST_ENV = "WARREN_PREVIEW_HOST" as const;
export const WARREN_PREVIEW_MODE_ENV = "WARREN_PREVIEW_MODE" as const;

export interface PreviewLaunchConfig {
	/**
	 * Host suffix the proxy preamble matches on (`Host: run-<id>.<host>`).
	 * Null when the operator hasn't wired the proxy yet — `preview_launch`
	 * still runs (the eviction worker / manual teardown all key off
	 * `runs.preview_state`), but `pr_annotate_preview` skips because there
	 * is no URL to publish.
	 *
	 * In path mode (default, warren-fcb7 / SPEC §11.L path addendum) the proxy
	 * preamble derives the preview origin from the request's own `Host` and
	 * routes by path prefix, so `host` being null no longer disables the
	 * preview surface — only subdomain mode still requires this to be set.
	 */
	readonly host: string | null;
	/**
	 * Routing mode for previews (warren-fcb7 / SPEC §11.L path addendum).
	 * `path` (default): previews served at `https://<warren-host>/p/<run-id>/`.
	 * `subdomain`: previews served at `https://run-<id>.<host>/`. The env
	 * surface wins over any per-project `.warren/preview.yaml` `mode` pin
	 * (merge precedence enforced by the call site, not here).
	 */
	readonly mode: PreviewMode;
}

export type PreviewLaunchEnvLike = Readonly<Record<string, string | undefined>>;

export function loadPreviewLaunchConfigFromEnv(
	env: PreviewLaunchEnvLike = process.env,
): PreviewLaunchConfig {
	const rawHost = env[WARREN_PREVIEW_HOST_ENV];
	const trimmedHost = rawHost === undefined ? "" : rawHost.trim();
	const host = trimmedHost === "" ? null : trimmedHost;

	const rawMode = env[WARREN_PREVIEW_MODE_ENV];
	const trimmedMode = rawMode === undefined ? "" : rawMode.trim().toLowerCase();
	// Invalid / empty value silently falls back to DEFAULT_PREVIEW_MODE — the
	// env knob mirrors how other WARREN_PREVIEW_* values degrade (mx-d3b88f)
	// rather than blocking server boot. Doctor / readyz callers can layer on
	// a strict validation pass later if operators want one.
	const parsedMode = PreviewModeSchema.safeParse(trimmedMode);
	const mode: PreviewMode = parsedMode.success ? parsedMode.data : DEFAULT_PREVIEW_MODE;

	return { host, mode };
}

/**
 * Format the preview URL for a `live` preview. The host suffix is the
 * operator's `WARREN_PREVIEW_HOST`; URLs are always `https` per SPEC §11.D
 * (TLS terminates on the operator's reverse proxy).
 *
 * - **Subdomain mode** (`https://run-<id>.<host>`): the reviewer-facing
 *   shape from the original §11.L. No trailing slash so the URL stays
 *   stable across modes and existing PR annotations.
 * - **Path mode** (`https://<host>/p/<id>/`, warren-c3c4 / SPEC §11.L
 *   addendum): trailing slash is load-bearing — without it the browser
 *   resolves the upstream's root-relative HTML (`href="/assets/foo"`)
 *   against `/p/` instead of `/p/<id>/`, defeating the proxy preamble.
 */
export function formatPreviewUrl(runId: string, host: string, mode: PreviewMode): string {
	if (mode === "path") {
		return `https://${host}/p/${runId}/`;
	}
	return `https://run-${runId}.${host}`;
}
