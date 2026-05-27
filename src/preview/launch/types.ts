/**
 * Public types + tunable constants for the preview launch flow
 * (warren-62a7 / pl-9088 step 9). The orchestration function
 * `launchPreview` lives in `./orchestrate.ts` and reads these knobs from
 * its `LaunchPreviewInput`; tests inject overrides field-by-field.
 *
 * See `./index.ts` for the module-level walkthrough and `./orchestrate.ts`
 * for the actual state machine (port → setup → spawn → probe → persist).
 */

import type { Repos } from "../../db/repos/index.ts";
import type { ServerPreviewConfig } from "../../warren-config/index.ts";
import type { PreviewPortAllocator } from "../port-allocator.ts";

/* ----------------------------------------------------------------------- */
/* Burrow facade                                                            */
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

/* ----------------------------------------------------------------------- */
/* Launch inputs / outputs                                                  */
/* ----------------------------------------------------------------------- */

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
	/**
	 * Override the phase-1 TCP-connect probe (tests). Real callers leave
	 * this undefined so `tcpConnectOnce` is used. warren-44ed / pl-592f.
	 */
	readonly tcpConnect?: (
		host: string,
		port: number,
		timeoutMs: number,
	) => Promise<"connected" | "not_connected">;
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

/* ----------------------------------------------------------------------- */
/* Tunable defaults                                                         */
/* ----------------------------------------------------------------------- */

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
