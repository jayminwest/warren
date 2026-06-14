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

import type { Repos } from "../db/repos/index.ts";
import type { ScheduledSeed } from "../seeds-cli/index.ts";
import type { CronTrigger, DefaultsConfig } from "../warren-config/index.ts";
import { parseCron } from "./cron.ts";
import { TriggerDispatchError } from "./errors.ts";

export interface DispatchSpawnInput {
	readonly agentName: string;
	readonly projectId: string;
	readonly prompt: string;
	readonly trigger: string;
	readonly metadata?: unknown;
	/**
	 * Per-trigger spend cap (warren-a63d). Forwarded to the spawn flow as
	 * `maxCostUsdOverride` so the cron entry's `maxCostUsd` overrides the
	 * agent's own cap. Omitted when the trigger declares none.
	 */
	readonly maxCostUsd?: number;
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
			readonly kind: "error";
			readonly reason: string;
	  };

export async function dispatchCronTrigger(input: DispatchCronInput): Promise<DispatchCronResult> {
	const parseInput: { expression: string; timezone?: string } = {
		expression: input.trigger.cron,
		...(input.trigger.timezone !== undefined ? { timezone: input.trigger.timezone } : {}),
	};
	const parsed = parseCron(parseInput);
	if (!parsed.ok) {
		return { kind: "error", reason: `cron parse failed: ${parsed.message}` };
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

	const prompt = resolveCronPrompt(input.trigger, input.defaults);
	let runId: string;
	try {
		const spawned = await input.spawn({
			agentName: input.trigger.role,
			projectId: input.projectId,
			prompt,
			trigger: "cron",
			metadata: {
				triggerId: input.trigger.id,
				cron: input.trigger.cron,
				...(input.trigger.seed !== undefined ? { seed: input.trigger.seed } : {}),
			},
			...(input.trigger.maxCostUsd !== undefined ? { maxCostUsd: input.trigger.maxCostUsd } : {}),
		});
		runId = spawned.runId;
	} catch (err) {
		// Per pl-2f15 risk #5 we keep dispatch failures per-trigger; surface
		// the reason for the tick log without touching the row. Next tick
		// will recompute prev > last and retry.
		return { kind: "error", reason: `spawnRun failed: ${formatError(err)}` };
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
	readonly seed: ScheduledSeed;
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
 * Decide-and-spawn for a single scheduled seed. Returns `{kind: 'fired',
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
			reason: "no agent to dispatch — set defaults.defaultRole in .warren/defaults.json",
		};
	}

	const prompt = resolveScheduledPrompt(input.seed, input.defaults);
	try {
		const spawned = await input.spawn({
			agentName: role,
			projectId: input.projectId,
			prompt,
			trigger: "scheduled",
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
	seed: ScheduledSeed,
	defaults: DefaultsConfig | null | undefined,
): string {
	if (defaults?.defaultPrompt !== undefined && defaults.defaultPrompt.trim() !== "") {
		return defaults.defaultPrompt;
	}
	const titleSuffix = seed.title ? ` (${seed.title})` : "";
	return `Work on seed ${seed.id}${titleSuffix}.`;
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err instanceof TriggerDispatchError) return err.message;
	return String(err);
}
