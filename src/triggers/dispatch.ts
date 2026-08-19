/**
 * Per-trigger dispatch decisions for the R-06 scheduler.
 *
 * Two flows live here:
 *
 *   `dispatchCronTrigger` walks one cron entry against the warren-side
 *      triggers row to decide fire vs skip. The "no catch-up" semantic
 *      (pl-2f15 alternatives #4 / open-question #4) is encoded as:
 *
 *        first observation   → seed the row at `now`, do NOT fire
 *        previousRun > last  → fire ONCE, advance to `nextRun(now)`
 *        otherwise           → no fire; refresh `nextFireAt` only
 *
 *      This skips every missed slot during downtime: a 4-hour outage on
 *      an hourly trigger dispatches at most one run when warren comes
 *      back, not four.
 *
 *   `dispatchScheduledSeed` fires for any open seed whose
 *      `extensions.scheduledFor` is <= now. Order of operations matches
 *      pl-2f15 risk #4: spawn the run first, surface the (warren) run
 *      id as `trigger='scheduled'`, then call `clearScheduledFor`. The
 *      caller (tick loop) records system events on dispatch failure so
 *      the operator sees lingering scheduledFor extensions on the run.
 *
 * Both flows return a discriminated result the tick loop logs and
 * persists; neither throws on per-trigger failure so one bad entry can't
 * tear down the scheduler.
 */

import { formatError, NotFoundError } from "../core/errors.ts";
import type { ScheduledIssue } from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import type { CronTrigger, DefaultsConfig } from "../warren-config/index.ts";
import { parseCron } from "./cron.ts";
import {
	type CronRetryState,
	type CronRetryTracker,
	MAX_CRON_TRANSIENT_RETRIES,
} from "./cron-retry.ts";

export interface DispatchSpawnInput {
	readonly agentName: string;
	readonly projectId: string;
	readonly prompt: string;
	readonly trigger: string;
	/**
	 * Seeds issue id this dispatch is against (warren-9ce3). Forwarded onto
	 * `spawnRun`'s `seedId` so `runs.seed_id` is populated for scheduled-seed
	 * (and, when a cron entry points at a seed, cron) dispatches. Without
	 * this field the scheduler closure only saw the id buried in `metadata`,
	 * leaving `runs.seed_id` NULL for every cron/scheduled fire.
	 */
	readonly seedId?: string;
	readonly metadata?: unknown;
	/**
	 * Per-trigger spend cap (warren-a63d). Forwarded to the spawn flow as
	 * `maxCostUsdOverride` so the cron entry's `maxCostUsd` overrides the
	 * agent's own cap. Omitted when the trigger declares none.
	 */
	readonly maxCostUsd?: number;
	/**
	 * Fired once with the warren run id the moment the row is created, before
	 * runtime contact (warren-a0a2). Lets the cron dispatcher learn the row id
	 * even when the spawn later throws, so its bounded-retry GC can reclaim the
	 * transient never_started row. The production wiring forwards this onto
	 * `spawnRun`'s `onRunRowCreated`.
	 */
	readonly onRowCreated?: (runId: string) => void;
}

export interface DispatchSpawnResult {
	readonly runId: string;
}

/**
 * Minimal seam the dispatcher needs from the runs spawn pipeline. The
 * production wiring (tick.ts) plugs `spawnRun` here with all the
 * burrow/project context baked in via closure; tests inject a stub that
 * just returns a synthetic runId.
 */
export type DispatchSpawnFn = (input: DispatchSpawnInput) => Promise<DispatchSpawnResult>;

export interface DispatchCronInput {
	readonly projectId: string;
	readonly trigger: CronTrigger;
	readonly defaults?: DefaultsConfig | null;
	readonly now: Date;
	readonly repos: Pick<Repos, "triggers">;
	readonly spawn: DispatchSpawnFn;
	/**
	 * Per-trigger consecutive-transient-failure memory (warren-a0a2). When
	 * provided, the dispatcher caps in-slot transient retries at
	 * {@link MAX_CRON_TRANSIENT_RETRIES}, then consumes the slot and returns a
	 * `gave_up` result. Omitted by unit tests that don't exercise the bound —
	 * without it the legacy unbounded retry-every-tick behaviour holds.
	 */
	readonly retryTracker?: CronRetryTracker;
	/**
	 * GC seam for the transient `never_started` rows a failing slot mints
	 * (warren-a0a2). Wired to `repos.runs.deleteNeverStarted` in production; the
	 * dispatcher deletes the previous attempt's row on each retry (and on
	 * recovery), so a failed slot leaves at most one never_started row behind.
	 */
	readonly deleteNeverStartedRun?: (runId: string) => Promise<void>;
}

export type DispatchCronResult =
	| {
			readonly kind: "fired";
			readonly runId: string;
			readonly firedAt: Date;
			readonly nextFireAt: Date | null;
	  }
	| {
			readonly kind: "seeded";
			readonly nextFireAt: Date | null;
	  }
	| {
			readonly kind: "skipped";
			readonly nextFireAt: Date | null;
			readonly reason: string;
	  }
	| {
			/**
			 * warren-a0a2: the slot hit {@link MAX_CRON_TRANSIENT_RETRIES}
			 * consecutive transient spawn failures, so the dispatcher gave up on
			 * it — the trigger row was advanced (slot consumed) exactly like the
			 * permanent-failure path, and the tick logs `scheduler.cron_gave_up`.
			 * The next genuine slot fires normally: give-up consumes THIS slot
			 * only, it never disables the trigger.
			 */
			readonly kind: "gave_up";
			readonly reason: string;
			readonly nextFireAt: Date | null;
			readonly attempts: number;
	  }
	| {
			readonly kind: "error";
			readonly reason: string;
			/**
			 * True when the spawn failure is deterministic for this slot
			 * (the agent role won't resolve until the registry changes) — an
			 * `agent not found` NotFoundError. Transient failures (burrow
			 * briefly down, etc.) leave this false so the next tick retries.
			 * Step 2 (warren-17cc) consumes the cron slot when this is set so
			 * an unregistered agent warns once-per-slot instead of every tick.
			 */
			readonly permanent: boolean;
	  };

export async function dispatchCronTrigger(input: DispatchCronInput): Promise<DispatchCronResult> {
	const parseInput: { expression: string; timezone?: string } = {
		expression: input.trigger.cron,
		...(input.trigger.timezone !== undefined ? { timezone: input.trigger.timezone } : {}),
	};
	const parsed = parseCron(parseInput);
	if (!parsed.ok) {
		// A bad cron expression won't fix itself tick-to-tick, but the slot
		// machinery never advances here (no row read yet), so treat it as
		// non-permanent for slot-consumption purposes — the noise floor for a
		// malformed expression is one log per tick regardless.
		return { kind: "error", reason: `cron parse failed: ${parsed.message}`, permanent: false };
	}

	const row = await input.repos.triggers.get({
		projectId: input.projectId,
		triggerId: input.trigger.id,
	});
	const nextFireAt = parsed.cron.nextRun(input.now);

	if (row === null || row.lastFiredAt === null) {
		// First observation — seed the row at `now` so the prev/last
		// comparison on the next tick can detect a genuine new slot.
		await input.repos.triggers.upsert({
			projectId: input.projectId,
			triggerId: input.trigger.id,
			lastFiredAt: input.now.toISOString(),
			nextFireAt: nextFireAt?.toISOString() ?? null,
		});
		return { kind: "seeded", nextFireAt };
	}

	const last = new Date(row.lastFiredAt);
	const prev = parsed.cron.previousRun(input.now);
	if (prev === null || prev <= last) {
		// No new slot has elapsed since the last fire — refresh nextFireAt
		// in case the trigger expression changed and we need to roll the
		// upcoming-fire indicator forward.
		await input.repos.triggers.upsert({
			projectId: input.projectId,
			triggerId: input.trigger.id,
			nextFireAt: nextFireAt?.toISOString() ?? null,
		});
		return {
			kind: "skipped",
			nextFireAt,
			reason: "no new cron slot since last fire",
		};
	}

	// warren-a0a2: per-trigger bounded-retry memory for THIS slot. slotKey is
	// the row's lastFiredAt — stable while a slot's attempts keep failing (the
	// transient path leaves the row untouched), advancing the instant the slot
	// fires or is consumed, so `forSlot` resets the counter on a fresh slot.
	const retry = input.retryTracker?.forSlot(input.projectId, input.trigger.id, row.lastFiredAt);

	const prompt = resolveCronPrompt(input.trigger, input.defaults);
	let createdRunId: string | null = null;
	let runId: string;
	try {
		const spawned = await input.spawn({
			agentName: input.trigger.role,
			projectId: input.projectId,
			prompt,
			trigger: "cron",
			// warren-9ce3: surface the trigger's seed pointer on the seam so
			// the scheduler can forward it onto runs.seed_id.
			...(input.trigger.seed !== undefined ? { seedId: input.trigger.seed } : {}),
			metadata: {
				triggerId: input.trigger.id,
				cron: input.trigger.cron,
				...(input.trigger.seed !== undefined ? { seed: input.trigger.seed } : {}),
			},
			...(input.trigger.maxCostUsd !== undefined ? { maxCostUsd: input.trigger.maxCostUsd } : {}),
			// Learn the row id even if the spawn throws — the GC below reclaims it.
			onRowCreated: (id) => {
				createdRunId = id;
			},
		});
		runId = spawned.runId;
	} catch (err) {
		return handleCronSpawnFailure({ input, retry, nextFireAt, createdRunId, err });
	}

	// Recovered within the slot: drop the transient failure's row so only the
	// successful run remains in the runs list, then forget the slot.
	if (retry !== undefined) {
		await gcPriorFailure(input, retry.lastFailedRunId);
		input.retryTracker?.clear(input.projectId, input.trigger.id);
	}

	// Risk #4: stamp last_fired_at BEFORE any side-effect that might fail
	// (here, none — but the same pattern applies for scheduled seeds).
	await input.repos.triggers.recordFire({
		projectId: input.projectId,
		triggerId: input.trigger.id,
		firedAt: input.now,
		nextFireAt,
		runId,
	});

	return { kind: "fired", runId, firedAt: input.now, nextFireAt };
}

export interface DispatchScheduledInput {
	readonly projectId: string;
	/** warren-6234: neutral tracker DTO (was the seeds-cli ScheduledSeed). */
	readonly seed: ScheduledIssue;
	readonly defaults?: DefaultsConfig | null;
	readonly now: Date;
	readonly spawn: DispatchSpawnFn;
}

export type DispatchScheduledResult =
	| {
			readonly kind: "fired";
			readonly runId: string;
			readonly seedId: string;
			/**
			 * Resolved agent the seed was dispatched against (defaults.defaultRole).
			 * Exposed so the tick's post-fire `updateExtensions` write can merge
			 * `role` alongside `{scheduledFor:null, lastScheduledRun, lastRunId,
			 * lastRunAt, trigger:'scheduled'}` in a single sd update (pl-bb70
			 * step 5 / warren-2064).
			 */
			readonly role: string;
	  }
	| { readonly kind: "skipped"; readonly seedId: string; readonly reason: string }
	| { readonly kind: "error"; readonly seedId: string; readonly reason: string };

/**
 * Decide-and-spawn for a single scheduled issue (warren-6234: neutral
 * tracker DTO). Returns `{kind: 'fired',
 * runId, role}` so the caller can merge the full warren-namespaced
 * extension payload (role + trigger + lastRunId + lastRunAt + scheduledFor
 * clear + lastScheduledRun pointer) into the seed in a single sd update,
 * and surface extension-write failures as a system event on the run.
 */
export async function dispatchScheduledSeed(
	input: DispatchScheduledInput,
): Promise<DispatchScheduledResult> {
	if (input.seed.scheduledFor > input.now) {
		return { kind: "skipped", seedId: input.seed.id, reason: "scheduledFor in the future" };
	}

	const role = input.defaults?.defaultRole;
	if (role === undefined || role === "") {
		return {
			kind: "error",
			seedId: input.seed.id,
			reason: "no agent to dispatch — set defaultRole in .warren/config.yaml",
		};
	}

	const prompt = resolveScheduledPrompt(input.seed, input.defaults);
	try {
		const spawned = await input.spawn({
			agentName: role,
			projectId: input.projectId,
			prompt,
			trigger: "scheduled",
			// warren-9ce3: first-class seedId so runs.seed_id is populated
			// (was previously only buried in metadata and dropped by the
			// scheduler's spawnDispatch closure).
			seedId: input.seed.id,
			metadata: { seedId: input.seed.id, scheduledFor: input.seed.scheduledFor.toISOString() },
		});
		return { kind: "fired", runId: spawned.runId, seedId: input.seed.id, role };
	} catch (err) {
		return {
			kind: "error",
			seedId: input.seed.id,
			reason: `spawnRun failed: ${formatError(err)}`,
		};
	}
}

/**
 * Prompt resolution for cron triggers: explicit trigger.prompt wins,
 * then defaults.defaultPrompt, then a canonical "work on seed X" fallback
 * referencing the trigger's seed pointer. The fallback keeps the run
 * usable even when the project hasn't configured a defaultPrompt — full
 * template substitution lands in a follow-up.
 *
 * Exported so the HTTP "Run Now" route (warren-99c3) can dispatch a
 * trigger inline with the same prompt resolution the scheduler uses.
 */
export function resolveCronPrompt(
	trigger: CronTrigger,
	defaults: DefaultsConfig | null | undefined,
): string {
	if (trigger.prompt !== undefined && trigger.prompt.trim() !== "") return trigger.prompt;
	if (defaults?.defaultPrompt !== undefined && defaults.defaultPrompt.trim() !== "") {
		return defaults.defaultPrompt;
	}
	if (trigger.seed !== undefined) {
		return `Work on seed ${trigger.seed} (cron trigger ${trigger.id}).`;
	}
	return `Run cron trigger ${trigger.id}.`;
}

function resolveScheduledPrompt(
	seed: ScheduledIssue,
	defaults: DefaultsConfig | null | undefined,
): string {
	if (defaults?.defaultPrompt !== undefined && defaults.defaultPrompt.trim() !== "") {
		return defaults.defaultPrompt;
	}
	const titleSuffix = seed.title ? ` (${seed.title})` : "";
	return `Work on seed ${seed.id}${titleSuffix}.`;
}

/**
 * Classify a spawn failure as permanent for the current cron slot.
 *
 * A spawn that throws `NotFoundError('agent not found: <role>')` (from
 * `spawnRun` when `repos.agents.resolve` returns null) will keep failing
 * the same way for the entire slot window — the role isn't registered.
 * Retrying it every tick is pure noise, so the dispatcher treats it as
 * permanent and (step 2) advances the trigger row to consume the slot.
 *
 * Transient failures (burrow down, DB hiccup) are NOT permanent: they
 * may succeed on a later tick within the same slot, so they keep the
 * existing retry-next-tick behaviour.
 */
export function isPermanentSpawnFailure(err: unknown): boolean {
	return err instanceof NotFoundError && err.message.startsWith("agent not found:");
}

/**
 * Best-effort GC of a prior attempt's `never_started` row (warren-a0a2). A
 * null id (the failure happened before the row was created) or a missing GC
 * seam is a no-op; the `deleteNeverStartedRun` seam itself is guarded to only
 * ever delete a genuine never_started row, so a stray call can never drop a
 * real run.
 */
async function gcPriorFailure(input: DispatchCronInput, runId: string | null): Promise<void> {
	if (runId === null || input.deleteNeverStartedRun === undefined) return;
	await input.deleteNeverStartedRun(runId);
}

/**
 * Advance the trigger row to consume the elapsed slot (lastFiredAt=now,
 * nextFireAt=nextRun) and forget its retry memory. Shared by the
 * permanent-failure (warren-17cc) and give-up (warren-a0a2) paths: after this
 * the next tick sees `prev <= last` and skips until the next genuine slot.
 */
async function consumeCronSlot(input: DispatchCronInput, nextFireAt: Date | null): Promise<void> {
	await input.repos.triggers.upsert({
		projectId: input.projectId,
		triggerId: input.trigger.id,
		lastFiredAt: input.now.toISOString(),
		nextFireAt: nextFireAt?.toISOString() ?? null,
	});
	input.retryTracker?.clear(input.projectId, input.trigger.id);
}

interface CronSpawnFailureInput {
	readonly input: DispatchCronInput;
	readonly retry: CronRetryState | undefined;
	readonly nextFireAt: Date | null;
	readonly createdRunId: string | null;
	readonly err: unknown;
}

/**
 * Classify + handle a cron spawn failure without tearing down the scheduler
 * (pl-2f15 risk #5):
 *
 *   - permanent (agent-not-found): consume the slot so an unregistered agent
 *     warns once-per-slot, not every tick (warren-17cc). No row was minted.
 *   - transient under the cap: GC the previous attempt's never_started row
 *     (a failing slot keeps at most one), leave the trigger row untouched so
 *     the next tick retries within the slot.
 *   - transient at the cap (warren-a0a2): give up on THIS slot — consume it
 *     and surface `gave_up` so the tick logs `scheduler.cron_gave_up`. The
 *     next genuine slot still fires; the trigger is never disabled.
 */
async function handleCronSpawnFailure(args: CronSpawnFailureInput): Promise<DispatchCronResult> {
	const { input, retry, nextFireAt, createdRunId, err } = args;
	if (isPermanentSpawnFailure(err)) {
		await consumeCronSlot(input, nextFireAt);
		return { kind: "error", reason: `spawnRun failed: ${formatError(err)}`, permanent: true };
	}

	if (retry !== undefined) {
		// GC the previous attempt's row; retain the current one (reclaimed by
		// the next retry / recovery, or kept as the give-up record).
		await gcPriorFailure(input, retry.lastFailedRunId);
		retry.consecutiveFailures += 1;
		retry.lastFailedRunId = createdRunId;
		if (retry.consecutiveFailures >= MAX_CRON_TRANSIENT_RETRIES) {
			const attempts = retry.consecutiveFailures;
			await consumeCronSlot(input, nextFireAt);
			return {
				kind: "gave_up",
				reason: `spawnRun failed ${attempts}x consecutively: ${formatError(err)}`,
				nextFireAt,
				attempts,
			};
		}
	}
	// Under the cap: leave the row untouched so the next tick retries the slot.
	return { kind: "error", reason: `spawnRun failed: ${formatError(err)}`, permanent: false };
}
