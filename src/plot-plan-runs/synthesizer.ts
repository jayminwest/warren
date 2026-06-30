/**
 * Plan synthesis seam for `POST /plot-plan-runs` (warren-99b2 / pl-f404
 * step 3 / SPEC §11.Q).
 *
 * The handler turns a Plot's open `seeds_issue` attachments into a
 * dispatchable seeds plan in two shell-outs:
 *
 *   1. `sd create --title "Plot <id> synthesized plan-run" --type task
 *       --description "..." --json`  → mints a fresh throwaway parent
 *       seed and returns its id.
 *   2. `sd plan submit <parent-id> --plan <tmpfile> --json` with a JSON
 *       payload whose `steps[]` all carry `existing_seed: "<candidate>"`
 *       — seeds-cli ≥ 0.4.7 (warren-d519 / seeds-5583) accepts adoption-
 *       only steps that omit `title`. Children become references to the
 *       named seeds, not new spawns.
 *
 * `seedsCli.spawn` doesn't carry a stdin channel, so the plan payload
 * rides in a per-call temp file under `tmpdir()`. The file is removed
 * in a `finally` regardless of submit success — a leaked tmpfile is a
 * disk-only nuisance, not a correctness issue, but cleaning up keeps
 * the host tidy.
 *
 * Failures bubble as `SdPlanSynthesisError` (500-mapped) regardless of
 * the underlying cause — non-zero exit, malformed JSON, missing `id` /
 * `plan_id` field. The caller-side request was well-formed, so the
 * 5xx posture is correct; 4xx is reserved for handler-edge rejects
 * (no .plot/, no .seeds/, zero candidates, malformed plot_id).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatError } from "../core/errors.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import { SdPlanSynthesisError } from "./errors.ts";

const DEFAULT_SD_TIMEOUT_MS = 30_000;

export interface SynthesizePlanInput {
	/** Project clone root — `sd` resolves `.seeds/` relative to cwd. */
	readonly projectPath: string;
	/** Plot id the synthesized plan is rooted at (used in titles + descriptions). */
	readonly plotId: string;
	/** Open `seeds_issue` attachment refs, in attachment order. */
	readonly candidateSeedIds: readonly string[];
}

export interface SynthesizePlanResult {
	/** The freshly minted throwaway parent seed id. */
	readonly parentSeedId: string;
	/** The freshly minted plan id (`pl-xxxx`). */
	readonly planId: string;
	/** Children of the plan, in submit order — mirror of input candidates. */
	readonly children: readonly string[];
}

export interface PlanSynthesizer {
	synthesize(input: SynthesizePlanInput): Promise<SynthesizePlanResult>;
}

export interface CreateDefaultPlanSynthesizerInput {
	readonly seedsCli: SeedsCliDeps;
}

/**
 * Build the plan JSON payload submitted to `sd plan submit`. Adoption-
 * only steps omit `title` per seeds-cli 0.4.7 — the adopted seed's
 * existing title flows through unchanged (and unrelated `sd plan show`
 * output reads correctly without warren having to fetch each title).
 *
 * Synthetic section content is deterministic so a re-synthesis against
 * the same Plot produces byte-identical plan rows on the JSONL append
 * (the parent + plan ids differ, but the sections don't churn). The
 * `context` field meets the feature template's `min_length: 50` AJV
 * constraint without any external lookup.
 *
 * Exported separately so the unit test can assert payload shape without
 * spinning up the full synthesizer.
 */
export function buildSynthesizedPlanJson(input: {
	readonly plotId: string;
	readonly candidateSeedIds: readonly string[];
}): string {
	const { plotId, candidateSeedIds } = input;
	const payload = {
		template: "feature",
		name: `Plot ${plotId} synthesized plan-run`,
		sections: {
			context: `Auto-synthesized by warren from Plot ${plotId}'s open seeds_issue attachments so the user can dispatch the bundle as a single plan-run instead of N manual runs (SPEC §11.Q).`,
			approach:
				"Adopt each attached seed as a plan child via existing_seed; the plan-run coordinator walks them serially, gating each on the previous PR merging.",
			steps: candidateSeedIds.map((seedId) => ({ existing_seed: seedId })),
			acceptance: [
				"every adopted child seed closes via its own PR-merge cycle",
				`the Plot ${plotId} auto-transitions to 'done' when the final child merges`,
			],
		},
	};
	return JSON.stringify(payload);
}

export function createDefaultPlanSynthesizer(
	input: CreateDefaultPlanSynthesizerInput,
): PlanSynthesizer {
	const { seedsCli } = input;
	return {
		async synthesize({ projectPath, plotId, candidateSeedIds }) {
			if (candidateSeedIds.length === 0) {
				throw new SdPlanSynthesisError(
					"cannot synthesize a plan with zero candidate seeds; the handler edge should have rejected with NoDispatchableSeedsError",
				);
			}
			const parentSeedId = await createParentSeed(seedsCli, projectPath, plotId);
			const planJson = buildSynthesizedPlanJson({ plotId, candidateSeedIds });
			const planId = await submitSynthesizedPlan({
				seedsCli,
				projectPath,
				parentSeedId,
				planJson,
			});
			return { parentSeedId, planId, children: [...candidateSeedIds] };
		},
	};
}

async function createParentSeed(
	seedsCli: SeedsCliDeps,
	projectPath: string,
	plotId: string,
): Promise<string> {
	const title = `Plot ${plotId} synthesized plan-run`;
	const description = `Auto-spawned by warren as the parent seed of a synthesized plan-run for Plot ${plotId}. Children adopt the Plot's open seeds_issue attachments via 'sd plan submit --existing_seed'. See SPEC §11.Q.`;
	const result = await seedsCli.spawn(
		[
			seedsCli.sdBinary,
			"create",
			"--title",
			title,
			"--type",
			"task",
			"--description",
			description,
			"--json",
		],
		{
			cwd: projectPath,
			timeoutMs: seedsCli.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
		},
	);
	if (result.exitCode !== 0) {
		throw new SdPlanSynthesisError(
			`sd create (synthesis parent for plot ${plotId}) exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		throw new SdPlanSynthesisError(
			`sd create (synthesis parent for plot ${plotId}) returned non-JSON: ${formatError(err)}`,
			{ cause: err },
		);
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new SdPlanSynthesisError(
			`sd create (synthesis parent for plot ${plotId}) returned a non-object payload: ${truncate(JSON.stringify(parsed))}`,
		);
	}
	const id = (parsed as { id?: unknown }).id;
	if (typeof id !== "string" || id.length === 0) {
		throw new SdPlanSynthesisError(
			`sd create (synthesis parent for plot ${plotId}) response missing string 'id': ${truncate(JSON.stringify(parsed))}`,
		);
	}
	return id;
}

async function submitSynthesizedPlan(input: {
	readonly seedsCli: SeedsCliDeps;
	readonly projectPath: string;
	readonly parentSeedId: string;
	readonly planJson: string;
}): Promise<string> {
	const { seedsCli, projectPath, parentSeedId, planJson } = input;
	const dir = await mkdtemp(join(tmpdir(), "warren-plot-plan-run-"));
	const file = join(dir, "plan.json");
	try {
		await writeFile(file, planJson, "utf8");
		const result = await seedsCli.spawn(
			[seedsCli.sdBinary, "plan", "submit", parentSeedId, "--plan", file, "--json"],
			{
				cwd: projectPath,
				timeoutMs: seedsCli.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
			},
		);
		if (result.exitCode !== 0) {
			throw new SdPlanSynthesisError(
				`sd plan submit ${parentSeedId} exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch (err) {
			throw new SdPlanSynthesisError(
				`sd plan submit ${parentSeedId} returned non-JSON: ${formatError(err)}`,
				{ cause: err },
			);
		}
		if (parsed === null || typeof parsed !== "object") {
			throw new SdPlanSynthesisError(
				`sd plan submit ${parentSeedId} returned a non-object payload: ${truncate(JSON.stringify(parsed))}`,
			);
		}
		const planId = (parsed as { plan_id?: unknown }).plan_id;
		if (typeof planId !== "string" || planId.length === 0) {
			throw new SdPlanSynthesisError(
				`sd plan submit ${parentSeedId} response missing string 'plan_id': ${truncate(JSON.stringify(parsed))}`,
			);
		}
		return planId;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

function truncate(raw: string, limit = 500): string {
	const trimmed = raw.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}… [truncated]`;
}
