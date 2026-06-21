/**
 * Shell-out readers for `sd plan show <id> --json` and `sd show <id> --json`.
 *
 * Two operations live here, both used by the plan-run coordinator (pl-a258
 * steps 5 + 6):
 *
 *   `showPlan` — read a plan's id/status/children/step blocks-DAG at
 *      PlanRun-create time so the coordinator can enumerate children in
 *      order without re-shelling `sd` on every tick.
 *
 *   `showSeed` — re-read a single child seed's status before dispatch so
 *      the coordinator can flip already-closed seeds to `skipped` (the
 *      warren-fcc9 resume-semantics path).
 *
 * Both use the same `SeedsCliDeps` + `SpawnFn` injection as
 * `listScheduledSeeds` / `updateExtensions` (mx-371491) so tests reuse the
 * same stubs, and both wrap shell + parse failures in `SeedsCliError`
 * with a copy-paste recoveryHint mirroring `listScheduledSeeds` lines
 * 50–60 of extensions.ts.
 */

import { SeedNotFoundError, SeedsCliError } from "./errors.ts";
import type { SeedsCliDeps } from "./extensions.ts";
import {
	PlanListEnvelopeSchema,
	PlanShowEnvelopeSchema,
	type PlanShowPlan,
	type PlanSummary,
	SeedShowEnvelopeSchema,
	type SeedShowIssue,
} from "./schema.ts";

const DEFAULT_SD_TIMEOUT_MS = 30_000;

export type PlanShowResult = PlanShowPlan;
export type SeedShowResult = SeedShowIssue;

/**
 * Read a project's seeds plans via `sd plan list --json` (warren-9b49 /
 * pl-dfb5 step 3). Returns wire-lean summaries (no `sections` body) so the
 * plan-run dispatch form can populate a plan-id selector. Shell + parse
 * failures wrap in `SeedsCliError` with a copy-paste recoveryHint, matching
 * `showPlan` / `listScheduledSeeds`.
 */
export async function listPlans(
	deps: SeedsCliDeps,
	projectPath: string,
): Promise<readonly PlanSummary[]> {
	const result = await deps.spawn([deps.sdBinary, "plan", "list", "--json"], {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new SeedsCliError(
			`sd plan list exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
			{ recoveryHint: `run \`${deps.sdBinary} plan list\` in ${projectPath} to diagnose` },
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		throw new SeedsCliError(`sd plan list returned non-JSON output: ${formatError(err)}`, {
			cause: err,
		});
	}

	const envelope = PlanListEnvelopeSchema.safeParse(parsed);
	if (!envelope.success) {
		throw new SeedsCliError(
			`sd plan list response did not match expected envelope: ${envelope.error.issues
				.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
				.join("; ")}`,
		);
	}

	return envelope.data.plans.map((plan) => ({
		id: plan.id,
		status: plan.status,
		childCount: plan.children?.length ?? 0,
		...(plan.seed !== undefined ? { seed: plan.seed } : {}),
		...(plan.template !== undefined ? { template: plan.template } : {}),
		...(plan.revision !== undefined ? { revision: plan.revision } : {}),
		...(plan.name !== undefined ? { name: plan.name } : {}),
		...(plan.createdAt !== undefined ? { createdAt: plan.createdAt } : {}),
		...(plan.updatedAt !== undefined ? { updatedAt: plan.updatedAt } : {}),
	}));
}

export async function showPlan(
	deps: SeedsCliDeps,
	projectPath: string,
	planId: string,
): Promise<PlanShowResult> {
	const result = await deps.spawn([deps.sdBinary, "plan", "show", planId, "--json"], {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		const detail = truncate(result.stderr || result.stdout);
		const message = `sd plan show ${planId} exited ${result.exitCode}: ${detail}`;
		const recoveryHint = `run \`${deps.sdBinary} plan show ${planId}\` in ${projectPath} to diagnose`;
		if (isNotFoundMessage(detail)) {
			throw new SeedNotFoundError(message, { recoveryHint });
		}
		throw new SeedsCliError(message, { recoveryHint });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		throw new SeedsCliError(
			`sd plan show ${planId} returned non-JSON output: ${formatError(err)}`,
			{ cause: err },
		);
	}

	const envelope = PlanShowEnvelopeSchema.safeParse(parsed);
	if (!envelope.success) {
		throw new SeedsCliError(
			`sd plan show ${planId} response did not match expected envelope: ${envelope.error.issues
				.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
				.join("; ")}`,
		);
	}

	return envelope.data.plan;
}

export async function showSeed(
	deps: SeedsCliDeps,
	projectPath: string,
	seedId: string,
): Promise<SeedShowResult> {
	const result = await deps.spawn([deps.sdBinary, "show", seedId, "--json"], {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		const detail = truncate(result.stderr || result.stdout);
		const message = `sd show ${seedId} exited ${result.exitCode}: ${detail}`;
		const recoveryHint = `run \`${deps.sdBinary} show ${seedId}\` in ${projectPath} to diagnose`;
		if (isNotFoundMessage(detail)) {
			throw new SeedNotFoundError(message, { recoveryHint });
		}
		throw new SeedsCliError(message, { recoveryHint });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		throw new SeedsCliError(`sd show ${seedId} returned non-JSON output: ${formatError(err)}`, {
			cause: err,
		});
	}

	const envelope = SeedShowEnvelopeSchema.safeParse(parsed);
	if (!envelope.success) {
		throw new SeedsCliError(
			`sd show ${seedId} response did not match expected envelope: ${envelope.error.issues
				.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
				.join("; ")}`,
		);
	}

	return envelope.data.issue;
}

/**
 * `sd show` / `sd plan show` exit 1 with a "not found" message when the id
 * doesn't resolve (e.g. `Issue not found`, `no such issue`). Distinguishing
 * this from a transient shell-out failure (timeout, lock) lets the plan-run
 * coordinator fail terminally instead of retrying forever (warren-0fed).
 */
function isNotFoundMessage(detail: string): boolean {
	return /not found|no such/i.test(detail);
}

function truncate(raw: string, limit = 500): string {
	const trimmed = raw.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}… [truncated]`;
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
