/**
 * Build the per-trigger HTTP/UI envelope for `GET /projects/:id/triggers`.
 *
 * Joins three sources in one pass:
 *
 *   1. The parsed `.warren/triggers.yaml` entry (R-02 warren-config) —
 *      authoring identity (id, cron, seed, role, timezone, prompt).
 *   2. The warren-side `triggers` table row (R-06 step 2) — `lastFiredAt`,
 *      persisted `nextFireAt`, `lastRunId`. May be absent for a trigger
 *      the scheduler has never observed yet.
 *   3. Croner's `nextRun(now)` — recomputed fresh per request so the wire
 *      `nextFireAt` always reflects the trigger's CURRENT expression even
 *      when the persisted row is stale (operator just edited the YAML).
 *
 * `parseError` is non-null when the trigger's cron expression passes the
 * loose warren-config check (5/6 tokens) but fails croner's strict parse.
 * In that case the fresh `nextFireAt` falls back to the persisted value
 * (which itself may be null if the trigger was never schedulable). The
 * scheduler tick logs the same parse failure as `scheduler.cron_failed`;
 * surfacing it here means operators see "what's wrong" on the UI without
 * tailing logs (pl-2f15 risk #1).
 */

import type { TriggersRepo } from "../db/repos/triggers.ts";
import type { CronTrigger } from "../warren-config/schema.ts";
import { parseCron } from "./cron.ts";

export interface TriggerSummary {
	readonly id: string;
	readonly kind: "cron";
	readonly cron: string;
	readonly seed?: string;
	readonly role: string;
	readonly timezone?: string;
	readonly prompt?: string;
	/** warren-a63d: the entry's per-run spend cap, surfaced so operators can verify it. */
	readonly maxCostUsd?: number;
	readonly lastFiredAt: string | null;
	readonly nextFireAt: string | null;
	readonly lastRunId: string | null;
	readonly parseError: string | null;
}

export interface BuildTriggerSummariesInput {
	readonly projectId: string;
	readonly triggers: readonly CronTrigger[];
	readonly repo: Pick<TriggersRepo, "get">;
	readonly now: Date;
}

export async function buildTriggerSummaries(
	input: BuildTriggerSummariesInput,
): Promise<TriggerSummary[]> {
	return Promise.all(input.triggers.map((trigger) => summarize(trigger, input)));
}

async function summarize(
	trigger: CronTrigger,
	input: BuildTriggerSummariesInput,
): Promise<TriggerSummary> {
	const row = await input.repo.get({ projectId: input.projectId, triggerId: trigger.id });

	const parseInput: { expression: string; timezone?: string } = {
		expression: trigger.cron,
		...(trigger.timezone !== undefined ? { timezone: trigger.timezone } : {}),
	};
	const parsed = parseCron(parseInput);

	let nextFireAt: string | null;
	let parseError: string | null;
	if (parsed.ok) {
		const next = parsed.cron.nextRun(input.now);
		nextFireAt = next?.toISOString() ?? row?.nextFireAt ?? null;
		parseError = null;
	} else {
		nextFireAt = row?.nextFireAt ?? null;
		parseError = parsed.message;
	}

	return {
		id: trigger.id,
		kind: trigger.kind,
		cron: trigger.cron,
		...(trigger.seed !== undefined ? { seed: trigger.seed } : {}),
		role: trigger.role,
		...(trigger.timezone !== undefined ? { timezone: trigger.timezone } : {}),
		...(trigger.prompt !== undefined ? { prompt: trigger.prompt } : {}),
		...(trigger.maxCostUsd !== undefined ? { maxCostUsd: trigger.maxCostUsd } : {}),
		lastFiredAt: row?.lastFiredAt ?? null,
		nextFireAt,
		lastRunId: row?.lastRunId ?? null,
		parseError,
	};
}
