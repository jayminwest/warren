/**
 * `teardownPreview` — `POST /runs/:id/preview/teardown` (R-19 / SPEC §11.L
 * acceptance #8, warren-d725).
 *
 * Operator-driven counterpart to the TTL+LRU eviction worker
 * (`src/preview/eviction/`, warren-ea6b). Same end-state on the runs
 * row (`preview_state='torn-down'`, `preview_port=null`), same
 * best-effort sidecar stop on burrow, but the trigger is a human via
 * the UI / curl rather than a periodic sweep.
 *
 *   1. **Resolve the run.** 404s fast for unknown ids (matches every
 *      other `/runs/:id` surface).
 *   2. **CAS via `RunPreviewsRepo.claimTeardown`.** BEGIN IMMEDIATE
 *      serializes against the eviction worker's `evict` so a manual
 *      teardown racing an LRU sweep deterministically lands in exactly
 *      one of them — the loser sees `already-torn-down` and returns
 *      idempotently without emitting a second event.
 *   3. **Stop the sidecar best-effort.** Only fires when the CAS
 *      transitioned `starting`/`live` → `torn-down`. Burrow's sidecar
 *      `list` + `delete` mirrors the eviction worker's pattern
 *      (mx-3b89c4). Failures are logged but never fail the response —
 *      the row state is already correct and the next eviction tick
 *      picks up any lingering process anyway.
 *   4. **Emit `preview_torn_down`.** Audit event on the run's event
 *      log, published through the broker so live UI subscribers see
 *      it without polling. Payload carries `actor` + `port` +
 *      `previousState` — same shape as the eviction worker's
 *      `preview_evicted` event plus an `actor` field for attribution.
 *
 * `actor` is a free-form string the route surfaces from the optional
 * request body (`{actor: "ui"}`); the cancel route follows the same
 * shape with `reason`. Defaults to `"manual"` so an operator curling
 * the route with no body still gets a useful audit trail.
 *
 * Cancellation / TTL is explicitly the eviction worker's concern; this
 * module only owns the manual transition. The route handler does its
 * own JSON shaping (`src/server/handlers/`).
 */

import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PreviewState } from "../db/schema.ts";
import type { RunEventBroker } from "../runs/events.ts";
import {
	createPoolSidecarResolver,
	type ManualTeardownStatus,
	type PreviewEvictionLogger,
	type RunPreviewsRepo,
	type SidecarResolver,
} from "./eviction/index.ts";

export type { ManualTeardownStatus };

export const PREVIEW_TORN_DOWN_EVENT_KIND = "preview_torn_down" as const;
export const DEFAULT_TEARDOWN_ACTOR = "manual" as const;

export interface TeardownPreviewInput {
	readonly runId: string;
	readonly repos: Repos;
	/**
	 * Drizzle-backed `RunPreviewsRepo` (BEGIN IMMEDIATE CAS) the handler
	 * threads in. Required — the route only lights up when the boot
	 * wiring constructed a sqlite-dialect previews repo (mirrors the
	 * eviction worker / port allocator posture, mx-b82a55).
	 */
	readonly previews: RunPreviewsRepo;
	readonly burrowClientPool: BurrowClientPool;
	readonly broker?: RunEventBroker;
	readonly now?: () => Date;
	readonly logger?: PreviewEvictionLogger;
	/**
	 * Free-form actor tag persisted on the audit event. Defaults to
	 * `manual` so a bare `POST` with no body still produces a useful
	 * audit trail. The route accepts `{actor}` in the JSON body and
	 * forwards verbatim.
	 */
	readonly actor?: string;
	/** Override the sidecar resolver (tests). Defaults to the pool-backed
	 *  resolver from `src/preview/eviction/sidecar.ts` (shared with the worker). */
	readonly resolveSidecar?: SidecarResolver;
}

export interface TeardownPreviewResult {
	readonly status: ManualTeardownStatus;
	/**
	 * True when the CAS transitioned a `starting`/`live` row → `torn-down`;
	 * false for the three idempotent branches. Mirrors `cancelRun`'s
	 * `alreadyTerminal` flag so consumers can avoid re-emitting telemetry
	 * on a no-op retry.
	 */
	readonly tornDown: boolean;
	readonly previousState: PreviewState | null;
	/** Port that was released (null when no port was held). */
	readonly port: number | null;
}

export async function teardownPreview(input: TeardownPreviewInput): Promise<TeardownPreviewResult> {
	const now = input.now ?? (() => new Date());
	const actor =
		input.actor !== undefined && input.actor.length > 0 ? input.actor : DEFAULT_TEARDOWN_ACTOR;

	// 404 fast for unknown ids — keeps the route's not-found contract on
	// the same posture as every other `/runs/:id` surface. The CAS below
	// also handles "row vanished between us" but routes through
	// `never-launched` rather than re-raising 404 from inside the txn.
	await input.repos.runs.require(input.runId);

	const resolveSidecar = input.resolveSidecar ?? createPoolSidecarResolver(input.burrowClientPool);

	const claim = await input.previews.claimTeardown({ runId: input.runId });
	if (claim.status !== "torn-down") {
		// Idempotent branches: no sidecar stop, no event. The row was
		// already in the requested state (or never opted into a preview),
		// so the operator's intent is satisfied without side effects.
		return {
			status: claim.status,
			tornDown: false,
			previousState: claim.previousState,
			port: claim.port,
		};
	}

	if (claim.burrowId !== null) {
		await stopSidecarsBestEffort({
			burrowId: claim.burrowId,
			runId: input.runId,
			resolveSidecar,
			...(input.logger !== undefined ? { logger: input.logger } : {}),
		});
	}

	await emitTornDownEvent({
		repos: input.repos,
		runId: input.runId,
		previousState: claim.previousState,
		port: claim.port,
		actor,
		now: now(),
		...(input.broker !== undefined ? { broker: input.broker } : {}),
		...(input.logger !== undefined ? { logger: input.logger } : {}),
	});

	input.logger?.info(
		{
			runId: input.runId,
			port: claim.port,
			previousState: claim.previousState,
			actor,
		},
		"preview_torn_down",
	);

	return {
		status: claim.status,
		tornDown: true,
		previousState: claim.previousState,
		port: claim.port,
	};
}

interface StopSidecarsInput {
	readonly burrowId: string;
	readonly runId: string;
	readonly resolveSidecar: SidecarResolver;
	readonly logger?: PreviewEvictionLogger;
}

async function stopSidecarsBestEffort(input: StopSidecarsInput): Promise<void> {
	try {
		const sidecars = await input.resolveSidecar(input.burrowId);
		if (sidecars === null) {
			input.logger?.warn(
				{ runId: input.runId, burrowId: input.burrowId },
				"preview_teardown.sidecar_resolver_returned_null",
			);
			return;
		}
		const list = await sidecars.list(input.burrowId);
		for (const sc of list) {
			try {
				await sidecars.delete(input.burrowId, sc.id);
			} catch (err) {
				input.logger?.warn(
					{
						runId: input.runId,
						burrowId: input.burrowId,
						sidecarId: sc.id,
						err: err instanceof Error ? err.message : String(err),
					},
					"preview_teardown.sidecar_delete_failed",
				);
			}
		}
	} catch (err) {
		input.logger?.warn(
			{
				runId: input.runId,
				burrowId: input.burrowId,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview_teardown.sidecar_stop_failed",
		);
	}
}

interface EmitTornDownInput {
	readonly repos: Repos;
	readonly broker?: RunEventBroker;
	readonly runId: string;
	readonly previousState: PreviewState | null;
	readonly port: number | null;
	readonly actor: string;
	readonly now: Date;
	readonly logger?: PreviewEvictionLogger;
}

async function emitTornDownEvent(input: EmitTornDownInput): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId: input.runId,
			burrowEventSeq: seq,
			ts: input.now.toISOString(),
			kind: PREVIEW_TORN_DOWN_EVENT_KIND,
			stream: "system",
			payload: {
				actor: input.actor,
				port: input.port,
				previousState: input.previousState,
			},
		});
		input.broker?.publish(input.runId, row);
	} catch (err) {
		// Event append failure is logged but never fails the route: the
		// row state is already correct and the operator can re-confirm
		// via GET /runs/:id. Matches the eviction worker's posture.
		input.logger?.error(
			{
				runId: input.runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview_teardown.event_emit_failed",
		);
	}
}
