/**
 * GitHub App credential heartbeat probe (warren-1295, plan pl-d1c9
 * acceptance criterion 8).
 *
 * The failure this exists to prevent (the PR #818 lesson): an App
 * credential died out-of-band — key revoked, App uninstalled, secret
 * deleted — and the symptom was a plan-run merge gate that simply
 * stalled, because `createPrMergeChecker` treats 401/403 as
 * keep-waiting. A dead credential was indistinguishable from a PR that
 * had not merged yet. The release workflow's `app-heartbeat` CI job
 * (commit 4c932878) checks the credential once per release; a credential
 * that dies at 3am mid-plan-run needs warren ITSELF to notice.
 *
 * The proof (same as the CI job's): App private keys carry no expiry, so
 * a successful installation-token mint is the whole liveness check. The
 * probe therefore FORCE-mints (`InstallationTokenSource.mintFresh`,
 * bypassing the cache read — a cached hit proves nothing) on a bounded
 * interval, and surfaces a failed mint LOUDLY through the existing
 * observability surfaces instead of letting it hide as apparent
 * patience:
 *
 *   - an error-level structured log line on every failed tick (carrying
 *     only the ForgeError `kind` + `detail` — never a secret; no new
 *     log-redact fields needed),
 *   - the `warren_forge_heartbeat_probe_total` metrics counter with
 *     `outcome` / `kind` labels, so a Grafana alert can fire on the
 *     failure rate,
 *   - an info-level recovery line on the first success after a failure.
 *
 * Rate-limit posture: the default interval is five minutes — twelve
 * `POST /app/installations/:id/access_tokens` calls per hour, and each
 * fresh token also lands in the `InstallationTokenSource` cache, so the
 * probe doubles as a cache warmer rather than adding load on top of real
 * traffic. The interval is configurable via
 * `WARREN_FORGE_HEARTBEAT_INTERVAL_MS` and clamped to a 30s floor so a
 * typo can't hammer the API. `WARREN_FORGE_HEARTBEAT_DISABLED=1` opts
 * out, mirroring the watchdog's env contract.
 *
 * Seam discipline: the injected `probe` returns `ForgeResult` and never
 * throws (forge-contract.md §2.2); a throw is still caught and logged so
 * a probe bug can never take down the boot loop. The timer is injectable
 * for tests, mirroring `bootWatchdog`.
 */

import { formatError } from "../../core/errors.ts";
import type { ForgeResult } from "../contract.ts";

export const FORGE_HEARTBEAT_INTERVAL_ENV = "WARREN_FORGE_HEARTBEAT_INTERVAL_MS";
export const FORGE_HEARTBEAT_DISABLED_ENV = "WARREN_FORGE_HEARTBEAT_DISABLED";

/** Default probe cadence — 12 mints/hour, each one warming the token cache. */
export const DEFAULT_FORGE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Floor for the interval knob — a faster cadence is a config bug, not tuning. */
export const MIN_FORGE_HEARTBEAT_INTERVAL_MS = 30 * 1000;

/** Metrics counter the probe increments once per tick. */
export const FORGE_HEARTBEAT_METRIC = "warren_forge_heartbeat_probe_total";

export interface ForgeHeartbeatConfig {
	readonly enabled: boolean;
	readonly intervalMs: number;
}

/** Minimal env surface the config loader reads. */
export type ForgeHeartbeatEnv = Readonly<Record<string, string | undefined>>;

/**
 * Parse the heartbeat knobs. Unset → enabled at the default cadence. A
 * non-integer interval throws (fail loud at boot, watchdog posture); a
 * sub-floor integer clamps UP to `MIN_FORGE_HEARTBEAT_INTERVAL_MS` rather
 * than refusing the boot over a tuning mistake.
 */
export function loadForgeHeartbeatConfigFromEnv(
	env: ForgeHeartbeatEnv = process.env,
): ForgeHeartbeatConfig {
	return {
		enabled: !parseDisabledFlag(env[FORGE_HEARTBEAT_DISABLED_ENV]),
		intervalMs: Math.max(
			parsePositiveInt(env[FORGE_HEARTBEAT_INTERVAL_ENV], FORGE_HEARTBEAT_INTERVAL_ENV),
			MIN_FORGE_HEARTBEAT_INTERVAL_MS,
		),
	};
}

function parseDisabledFlag(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const t = raw.trim().toLowerCase();
	return t === "1" || t === "true" || t === "yes" || t === "on";
}

function parsePositiveInt(raw: string | undefined, name: string): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_FORGE_HEARTBEAT_INTERVAL_MS;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`${name} must be a positive integer, got "${raw}"`);
	}
	return n;
}

/**
 * The probe itself: force-mint an installation token and report ONLY its
 * expiry — the secret never crosses this seam. Bound at boot to
 * `GitHubAppForge.probeCredential`.
 */
export type ForgeCredentialProbe = () => Promise<ForgeResult<{ expiresAt: number | null }>>;

/** Structural logger — the server's pino `Logger` satisfies this. */
export interface ForgeHeartbeatLogger {
	info(obj: object, msg?: string): void;
	warn(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
}

/** Structural counter sink — `MetricsRegistry` satisfies this. */
export interface ForgeHeartbeatMetrics {
	increment(name: string, labels: Readonly<Record<string, string>>): void;
}

export type ForgeHeartbeatTimerHandle = object;

export interface GitHubAppHeartbeatInput {
	readonly probe: ForgeCredentialProbe;
	readonly intervalMs: number;
	readonly logger: ForgeHeartbeatLogger;
	/** Optional metrics sink; omit in tests that only assert logs. */
	readonly metrics?: ForgeHeartbeatMetrics;
	/** Timer seams for tests; default to the global interval pair. */
	readonly setInterval?: (cb: () => void, ms: number) => ForgeHeartbeatTimerHandle;
	readonly clearInterval?: (handle: ForgeHeartbeatTimerHandle) => void;
}

export interface ForgeHeartbeatHandle {
	/** Clear the interval. A probe already in flight finishes; its log lands. */
	stop(): void;
}

/**
 * Start the heartbeat: one probe IMMEDIATELY (a credential that died
 * while warren was down is known within seconds of boot, not one
 * interval later), then one per `intervalMs`. Ticks never overlap — a
 * slow GitHub API skips the next tick rather than stacking probes.
 */
export function startGitHubAppHeartbeat(input: GitHubAppHeartbeatInput): ForgeHeartbeatHandle {
	const setTimer =
		input.setInterval ??
		((cb: () => void, ms: number) => globalThis.setInterval(cb, ms) as ForgeHeartbeatTimerHandle);
	const clearTimer =
		input.clearInterval ??
		((handle: ForgeHeartbeatTimerHandle) =>
			globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
	const { probe, intervalMs, logger, metrics } = input;

	let stopped = false;
	let inFlight = false;
	let failing = false;

	const tick = async (): Promise<void> => {
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			const result = await probe();
			if (result.ok) {
				metrics?.increment(FORGE_HEARTBEAT_METRIC, { outcome: "ok" });
				if (failing) {
					failing = false;
					logger.info(
						{ expiresAt: result.value.expiresAt },
						"forge heartbeat: GitHub App credential recovered — mints succeed again",
					);
				}
			} else {
				failing = true;
				metrics?.increment(FORGE_HEARTBEAT_METRIC, {
					outcome: "error",
					kind: result.error.kind,
				});
				logger.error(
					{ kind: result.error.kind, detail: result.error.detail },
					"forge heartbeat: GitHub App credential probe FAILED — App-mode forge operations (PR open, merge-gate checks, pushes) will stall or fail until the credential is restored",
				);
			}
		} catch (err) {
			// The contract says probe never throws (§2.2); if it does, that is
			// still a dead-credential signal, not a reason to crash the loop.
			failing = true;
			metrics?.increment(FORGE_HEARTBEAT_METRIC, { outcome: "error", kind: "probe_threw" });
			logger.error(
				{ reason: formatError(err) },
				"forge heartbeat: credential probe threw — treating as a dead-credential signal",
			);
		} finally {
			inFlight = false;
		}
	};

	void tick();
	const timer = setTimer(() => void tick(), intervalMs);
	// Never let the heartbeat keep a dying process alive on shutdown.
	(timer as { unref?: () => void }).unref?.();

	return {
		stop() {
			stopped = true;
			clearTimer(timer);
		},
	};
}
