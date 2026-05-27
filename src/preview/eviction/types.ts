/**
 * Shared types for the preview eviction worker (warren-d0a9 split of
 * src/preview/eviction.ts). Lives in its own file so `repo.ts`,
 * `tick.ts`, and `worker.ts` can share the contract without cycling
 * through `index.ts`.
 *
 * See `./index.ts` for the four-signal eviction contract framing and
 * SPEC §11.L for the design lock.
 */

import type { BurrowClientPool } from "../../burrow-client/pool.ts";
import type { AnyWarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { PreviewState } from "../../db/schema.ts";
import type { RunEventBroker } from "../../runs/events.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { PreviewSidecarsClient } from "../launch.ts";

export interface PreviewEvictionConfig {
	readonly idleTtlMs: number;
	readonly maxLifetimeMs: number;
	readonly maxLive: number;
	readonly tickMs: number;
	readonly disabled: boolean;
}

export type EvictionReason = "idle_ttl" | "max_lifetime" | "lru";

export interface PreviewEvictionLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Sidecar surface the worker needs from the burrow facade. Same `delete`
 * verb the launcher already uses; tests inject a fake that captures calls.
 */
export type SidecarClient = Pick<PreviewSidecarsClient, "delete"> & {
	list(burrowId: string): Promise<readonly { readonly id: string }[]>;
};

export type SidecarResolver = (burrowId: string) => Promise<SidecarClient | null>;

export interface RunPreviewRow {
	readonly runId: string;
	readonly projectId: string | null;
	readonly burrowId: string | null;
	readonly workerId: string | null;
	readonly previewState: "starting" | "live";
	readonly previewPort: number | null;
	readonly previewStartedAt: string | null;
	readonly previewLastHitAt: string | null;
}

/**
 * Outcome of a manual teardown CAS (warren-d725). The route returns the
 * shape verbatim in the response envelope so a client / UI can tell
 * "we just tore it down" apart from "it was already gone" without a
 * second round-trip — same posture as `cancelRun`'s `alreadyTerminal`
 * flag (mx-… cancel handler).
 *
 *   - `torn-down`        — was `starting`/`live`; CAS flipped it to
 *                          `torn-down`, port released. Caller emits a
 *                          `preview_torn_down` audit event.
 *   - `already-torn-down`— row was already `torn-down`; no event.
 *   - `already-failed`   — row is in terminal `failed` state. Port is
 *                          already null (set by the launcher on the
 *                          fail transition); no work needed, no event.
 *   - `never-launched`   — `preview_state` is null. The project never
 *                          opted in or reap's preview sub-step never
 *                          fired. No event.
 *
 * `previousState` mirrors the column the CAS read; `port` is the value
 * that was cleared (null when the row never carried one).
 */
export type ManualTeardownStatus =
	| "torn-down"
	| "already-torn-down"
	| "already-failed"
	| "never-launched";

export interface ManualTeardownClaim {
	readonly status: ManualTeardownStatus;
	readonly previousState: PreviewState | null;
	readonly port: number | null;
	readonly burrowId: string | null;
}

export interface RunPreviewsRepo {
	listActivePreviews(): Promise<readonly RunPreviewRow[]>;
	countActivePreviews(): Promise<number>;
	evict(input: {
		readonly runId: string;
		readonly reason: EvictionReason;
		readonly now: Date;
	}): Promise<boolean>;
	/**
	 * Atomically claim a `starting`/`live` preview for manual teardown
	 * (R-19 / SPEC §11.L acceptance #8, warren-d725). BEGIN IMMEDIATE
	 * serializes against the eviction worker's `evict` so a manual
	 * teardown racing an LRU sweep deterministically lands in exactly
	 * one of them — the loser sees `already-torn-down`. Returns the
	 * shape `teardownPreview` shapes onto the wire response and emits
	 * `preview_torn_down` against.
	 */
	claimTeardown(input: { readonly runId: string }): Promise<ManualTeardownClaim>;
}

export interface PreviewEvictionTickInput {
	readonly db: AnyWarrenDb;
	readonly repos: Repos;
	readonly burrowClientPool: BurrowClientPool;
	readonly warrenConfigs: WarrenConfigCache;
	readonly broker?: RunEventBroker;
	readonly config: PreviewEvictionConfig;
	readonly now?: () => Date;
	readonly logger?: PreviewEvictionLogger;
	/**
	 * Override the sidecar resolver (tests). Defaults to a pool-backed
	 * resolver that looks up the worker for `burrowId` and returns its
	 * `http.sidecars` facade. Returns `null` when the worker can't be
	 * resolved (e.g. the burrow row was deleted while the run was still
	 * carrying a stale `burrow_id`) so the eviction still runs db-side
	 * but the sidecar stop is skipped with a warning.
	 */
	readonly resolveSidecar?: SidecarResolver;
	/**
	 * Override the previews repo (tests). Defaults to a thin wrapper over
	 * `repos.runs` + drizzle. The CAS in `evict` is a single conditional
	 * UPDATE so a racing manual teardown is idempotent at the SQL layer.
	 */
	readonly previews?: RunPreviewsRepo;
}

export interface PreviewEvictionTickResult {
	readonly scanned: number;
	readonly evicted: ReadonlyArray<{ readonly runId: string; readonly reason: EvictionReason }>;
	readonly skipped: ReadonlyArray<{ readonly runId: string; readonly reason: string }>;
}
