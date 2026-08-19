/**
 * Dispatch-context writer (warren-d6ca / pl-a37b Track A).
 *
 * One insert-only row per dispatch, written inside `spawnRun` immediately
 * after `repos.runs.create` returns and BEFORE any runtime contact — so a
 * never-started failure still gets a snapshot. Mirrors
 * {@link writeSeedExtensions}: fire-and-log. A failed context write must
 * never fail a dispatch.
 *
 * Lives beside `dispatch.ts` (at the 500-line budget) rather than inside it.
 * Facts only. NULL means unknown, never a bucket.
 */

import { formatError } from "../../core/errors.ts";
import type { InsertDispatchContextInput } from "../../db/repos/dispatch-context.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunRow } from "../../db/schema.ts";
import { type AgentDefinition, readRuntimeId } from "../../registry/schema.ts";
import { type DefaultsConfig, interactiveRuntimeOverride } from "../../warren-config/schema.ts";
import { readMaxCostUsd } from "../cost-cap.ts";
import type { DispatchOrigin, SpawnLogger, SpawnRunInput } from "./types.ts";

/** Closed vocabulary for `dispatch_context.retry_kind` (warren-36e7). */
export const RETRY_KINDS = ["none", "infra_lost", "provider_error", "plan_child"] as const;
export type RetryKind = (typeof RETRY_KINDS)[number];

/** Closed vocabulary for override-source columns (warren-36e7). */
export const OVERRIDE_SOURCES = ["override", "project_default", "frontmatter"] as const;
export type OverrideSource = (typeof OVERRIDE_SOURCES)[number];

/** Queue snapshot always comes from the runs table (warren-e1f1). */
export const QUEUE_SNAPSHOT_SOURCE = "runs_table" as const;

const PROMPT_ENCODER = new TextEncoder();

/** Cycle-guard ceiling when walking a retry/parent chain. */
const MAX_LINEAGE_WALK = 32;

export interface WriteDispatchContextInput {
	repos: Repos;
	run: RunRow;
	agentName: string;
	provider: string | undefined;
	model: string | undefined;
	/**
	 * Pre-fold agent frontmatter — used ONLY for cap-source tier detection so a
	 * project default folded onto the frozen envelope is not mis-attributed as
	 * frontmatter.
	 */
	baseFrontmatter: Readonly<Record<string, unknown>>;
	/** Post-fold frontmatter (override chain already applied) — effective values. */
	frontmatter: Readonly<Record<string, unknown>>;
	providerOverride?: string;
	modelOverride?: string;
	maxCostUsdOverride?: number;
	projectDefaultProvider?: string;
	projectDefaultModel?: string;
	projectDefaultMaxCostUsd?: number;
	runtimeId: string;
	runtimeBackend: string;
	prompt: string;
	/** warren-540f: project repoContext — its bytes count into prompt_bytes. */
	repoContext?: string;
	mode: string;
	network: string;
	trigger: string;
	dispatchOrigin?: DispatchOrigin;
	dispatcherHandle?: string;
	metadata?: unknown;
	seedId?: string;
	now: Date;
	logger?: SpawnLogger;
}

/**
 * spawnRun-facing entry: assemble the snapshot from the live spawn inputs
 * and insert it. Keeps the call site in dispatch.ts to a handful of lines
 * (dispatch.ts sits at the 500-line budget). Fire-and-log — every failure
 * is swallowed after a warn + system event so a bad context write never
 * fails a dispatch. Idempotent on `run_id` via ON CONFLICT DO NOTHING.
 */
export async function writeDispatchContext(args: {
	readonly spawn: SpawnRunInput;
	readonly run: RunRow;
	readonly agent: AgentDefinition;
	/** Pre-fold agent definition — cap-source tier reads its frontmatter. */
	readonly baseAgent: AgentDefinition;
	readonly declaredProvider: string | undefined;
	readonly declaredModel: string | undefined;
	readonly projectDefaults: DefaultsConfig | null | undefined;
	readonly network: string;
}): Promise<void> {
	const input = assembleWriteInput(args);
	// warren-540f: repoContext rides the prompt — its bytes count into prompt_bytes.
	if (args.projectDefaults?.repoContext !== undefined) {
		input.repoContext = args.projectDefaults.repoContext;
	}
	try {
		const row = await buildDispatchContextRow(input);
		await input.repos.dispatchContext.insert(row);
	} catch (err) {
		input.logger?.warn?.(
			{
				event: "dispatch_context.write_failed",
				run_id: input.run.id,
				reason: formatError(err),
			},
			"dispatch-context: write failed; dispatch continues",
		);
		await recordWriteFailedEvent(input.repos, input.run.id, input.now, formatError(err));
	}
}

/** Fold spawn-site inputs into the builder's flat bag. */
function assembleWriteInput(args: {
	readonly spawn: SpawnRunInput;
	readonly run: RunRow;
	readonly agent: AgentDefinition;
	readonly baseAgent: AgentDefinition;
	readonly declaredProvider: string | undefined;
	readonly declaredModel: string | undefined;
	readonly projectDefaults: DefaultsConfig | null | undefined;
	readonly network: string;
}): WriteDispatchContextInput {
	const { spawn, run, agent, projectDefaults } = args;
	const draft: WriteDispatchContextInput = {
		repos: spawn.repos,
		run,
		agentName: agent.name,
		provider: args.declaredProvider,
		model: args.declaredModel,
		baseFrontmatter: args.baseAgent.frontmatter,
		frontmatter: agent.frontmatter,
		runtimeId: readRuntimeId(
			agent,
			interactiveRuntimeOverride(agent.name, projectDefaults ?? null),
		),
		runtimeBackend: spawn.runtimeProvider.kind,
		prompt: spawn.prompt,
		mode: spawn.mode ?? "batch",
		network: args.network,
		trigger: spawn.trigger ?? "manual",
		now: spawn.now?.() ?? new Date(),
	};
	// Optional fields — assign only when present so the insert omits unknowns
	// as NULL rather than writing empty strings.
	if (spawn.providerOverride !== undefined) draft.providerOverride = spawn.providerOverride;
	if (spawn.modelOverride !== undefined) draft.modelOverride = spawn.modelOverride;
	if (spawn.maxCostUsdOverride !== undefined) draft.maxCostUsdOverride = spawn.maxCostUsdOverride;
	if (projectDefaults?.defaultProvider !== undefined) {
		draft.projectDefaultProvider = projectDefaults.defaultProvider;
	}
	if (projectDefaults?.defaultModel !== undefined) {
		draft.projectDefaultModel = projectDefaults.defaultModel;
	}
	if (projectDefaults?.maxCostUsd !== undefined) {
		draft.projectDefaultMaxCostUsd = projectDefaults.maxCostUsd;
	}
	if (spawn.dispatchOrigin !== undefined) draft.dispatchOrigin = spawn.dispatchOrigin;
	if (spawn.dispatcherHandle !== undefined) draft.dispatcherHandle = spawn.dispatcherHandle;
	if (spawn.metadata !== undefined) draft.metadata = spawn.metadata;
	if (spawn.seedId !== undefined) draft.seedId = spawn.seedId;
	if (spawn.logger !== undefined) draft.logger = spawn.logger;
	return draft;
}

/**
 * Pure-ish builder (async only for the lineage walk + queue counts).
 * Exported for unit tests that want the row shape without the insert.
 */
export async function buildDispatchContextRow(
	input: WriteDispatchContextInput,
): Promise<InsertDispatchContextInput> {
	const providerSource = resolveFieldSource(
		input.providerOverride,
		input.projectDefaultProvider,
		input.provider,
	);
	const modelSource = resolveFieldSource(
		input.modelOverride,
		input.projectDefaultModel,
		input.model,
	);
	const { source: capSource, value: maxCostUsd } = resolveCapSource(input);
	const meta = readMetadataBag(input.metadata);
	const lineage = await resolveRetryLineage(input.repos, input.run, input.dispatchOrigin);
	const queue = await snapshotQueue(input.repos, input.run.projectId);

	return {
		runId: input.run.id,
		createdAt: input.now.toISOString(),
		agentName: input.agentName,
		...(input.provider !== undefined ? { provider: input.provider } : {}),
		...(input.model !== undefined ? { model: input.model } : {}),
		...(providerSource !== null ? { providerSource } : {}),
		...(modelSource !== null ? { modelSource } : {}),
		...(capSource !== null ? { capSource } : {}),
		...(maxCostUsd !== null ? { maxCostUsd } : {}),
		runtimeId: input.runtimeId,
		runtimeBackend: input.runtimeBackend,
		// warren-540f: prompt_bytes counts the user prompt plus the injected
		// repoContext block (the schema caps the latter at 8 KiB). The agent
		// `system` body is NOT counted — it is frozen per-agent, not dispatch-time
		// input, and pre-540f rows would not be comparable if it were.
		promptBytes:
			PROMPT_ENCODER.encode(input.prompt).byteLength +
			(input.repoContext !== undefined ? PROMPT_ENCODER.encode(input.repoContext).byteLength : 0),
		mode: input.mode,
		network: input.network,
		queueQueuedRuns: queue.queued,
		queueRunningRuns: queue.running,
		queueProjectNonTerminal: queue.projectNonTerminal,
		queueSnapshotSource: QUEUE_SNAPSHOT_SOURCE,
		trigger: input.trigger,
		...(input.dispatchOrigin !== undefined ? { dispatchOrigin: input.dispatchOrigin } : {}),
		...(input.dispatcherHandle !== undefined ? { dispatcherHandle: input.dispatcherHandle } : {}),
		...(meta.triggerId !== undefined ? { triggerId: meta.triggerId } : {}),
		...(meta.planRunId !== undefined ? { planRunId: meta.planRunId } : {}),
		retryKind: lineage.retryKind,
		...(lineage.retryOfRunId !== null ? { retryOfRunId: lineage.retryOfRunId } : {}),
		...(lineage.parentRunId !== null ? { parentRunId: lineage.parentRunId } : {}),
		attemptNo: lineage.attemptNo,
		rootRunId: lineage.rootRunId,
		...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
	};
}

/**
 * Resolve which tier supplied a provider/model value. Only meaningful when
 * a resolved value is present; otherwise NULL (unknown), never a bucket.
 */
export function resolveFieldSource(
	operator: string | undefined,
	projectDefault: string | undefined,
	resolved: string | undefined,
): OverrideSource | null {
	if (resolved === undefined) return null;
	const op = operator?.trim();
	if (op !== undefined && op !== "") return "override";
	const pd = projectDefault?.trim();
	if (pd !== undefined && pd !== "") return "project_default";
	return "frontmatter";
}

/**
 * Cap tier + effective USD. Precedence mirrors `resolveCapOverride`:
 * dispatch override > agent frontmatter (declared, even if malformed) >
 * project default. Tier detection reads the PRE-fold frontmatter so a
 * project default folded onto the frozen envelope is not mis-labelled
 * `frontmatter`. The value is the post-fold reading so the snapshot
 * matches what the bridge will enforce.
 */
export function resolveCapSource(input: {
	readonly maxCostUsdOverride?: number;
	readonly baseFrontmatter: Readonly<Record<string, unknown>>;
	readonly frontmatter: Readonly<Record<string, unknown>>;
	readonly projectDefaultMaxCostUsd?: number;
}): { source: OverrideSource | null; value: number | null } {
	const effective = readMaxCostUsd(input.frontmatter);
	if (input.maxCostUsdOverride !== undefined) {
		return { source: "override", value: effective ?? input.maxCostUsdOverride };
	}
	const declared = input.baseFrontmatter.maxCostUsd;
	if (declared !== undefined && declared !== null) {
		// Malformed agent caps fail open (effective=null) but still count as
		// the frontmatter tier — evidence of the typo stays attributed.
		return { source: "frontmatter", value: effective };
	}
	if (input.projectDefaultMaxCostUsd !== undefined) {
		return { source: "project_default", value: effective ?? input.projectDefaultMaxCostUsd };
	}
	return { source: null, value: null };
}

/**
 * Normalize the three retry-lineage encodings onto one (kind, attempt, root)
 * triple. Kind comes from the dispatch site when stamped; otherwise from the
 * row shape. attempt_no / root_run_id walk the appropriate parent chain.
 *
 * Encodings (post warren-eaa6):
 *   - infra-lost: `runs.retry_of` set, no parent; origin `retry_infra_lost`
 *   - provider-retry: `parent_run_id` + `clone_kind=replicate` (+ `retry_of`);
 *     origin `retry_provider`
 *   - plan-child retry: no marker on the run row at all (origin stays
 *     `plan_run`) — recorded as `none` here; the plan-run coordinator owns
 *     the retry_count on the child row, not the runs table
 *   - plain continuation (`clone_kind=continue`) is NOT a retry
 */
export async function resolveRetryLineage(
	repos: Repos,
	run: RunRow,
	dispatchOrigin: DispatchOrigin | undefined,
): Promise<{
	retryKind: RetryKind;
	retryOfRunId: string | null;
	parentRunId: string | null;
	attemptNo: number;
	rootRunId: string;
}> {
	const retryKind = deriveRetryKind(run, dispatchOrigin);
	const parentRunId = run.parentRunId;
	const retryOfRunId = run.retryOf ?? (retryKind === "provider_error" ? run.parentRunId : null);

	// Only infra_lost / provider_error carry a walkable runs-table chain.
	// plan_child has no run-row marker; none is a root.
	if (retryKind !== "infra_lost" && retryKind !== "provider_error") {
		return {
			retryKind,
			retryOfRunId: run.retryOf,
			parentRunId,
			attemptNo: 1,
			rootRunId: run.id,
		};
	}

	const walked = await walkRetryChain(repos, run, retryKind);
	return {
		retryKind,
		retryOfRunId,
		parentRunId,
		attemptNo: walked.attemptNo,
		rootRunId: walked.rootRunId,
	};
}

export function deriveRetryKind(
	run: Pick<RunRow, "retryOf" | "parentRunId" | "cloneKind">,
	dispatchOrigin: DispatchOrigin | undefined,
): RetryKind {
	if (dispatchOrigin === "retry_infra_lost") return "infra_lost";
	if (dispatchOrigin === "retry_provider") return "provider_error";
	// Fallback for callers that forgot the origin stamp (or tests):
	// infra-lost is retry_of without a parent link; provider-retry is a
	// replicate parent link (retry_of may also be set post warren-eaa6).
	if (run.retryOf !== null && run.parentRunId === null) return "infra_lost";
	if (run.parentRunId !== null && run.cloneKind === "replicate") return "provider_error";
	return "none";
}

/**
 * Walk retry_of (infra-lost) or parent_run_id/retry_of (provider) back to
 * the root. attempt_no is 1-indexed from the root (root=1, first retry=2).
 */
async function walkRetryChain(
	repos: Repos,
	run: RunRow,
	kind: Exclude<RetryKind, "none" | "plan_child">,
): Promise<{ attemptNo: number; rootRunId: string }> {
	let current: RunRow = run;
	let attemptNo = 1;
	const seen = new Set<string>([run.id]);

	for (let i = 0; i < MAX_LINEAGE_WALK; i++) {
		const parentId = parentIdForKind(current, kind);
		if (parentId === null) break;
		if (seen.has(parentId)) break;
		seen.add(parentId);
		const parent: RunRow | null = await repos.runs.get(parentId);
		if (parent === null) {
			// Parent row gone — treat the dangling id as the root and count
			// the hop so attempt_no still reflects chain depth.
			return { attemptNo: attemptNo + 1, rootRunId: parentId };
		}
		current = parent;
		attemptNo += 1;
	}
	return { attemptNo, rootRunId: current.id };
}

function parentIdForKind(
	run: Pick<RunRow, "retryOf" | "parentRunId">,
	kind: Exclude<RetryKind, "none" | "plan_child">,
): string | null {
	if (kind === "infra_lost") return run.retryOf;
	// provider_error: prefer retry_of (warren-eaa6), fall back to parent.
	return run.retryOf ?? run.parentRunId;
}

async function snapshotQueue(
	repos: Repos,
	projectId: string | null,
): Promise<{ queued: number; running: number; projectNonTerminal: number }> {
	// listByState is the public surface; queue depth is small and the
	// snapshot is best-effort. countNonTerminal covers the per-project arm
	// (warren-e1f1) without a second full-table scan shape.
	const [queuedRows, runningRows] = await Promise.all([
		repos.runs.listByState("queued"),
		repos.runs.listByState("running"),
	]);
	const projectNonTerminal =
		projectId === null
			? queuedRows.length + runningRows.length
			: await repos.runs.countNonTerminal(projectId);
	return {
		queued: queuedRows.length,
		running: runningRows.length,
		projectNonTerminal,
	};
}

function readMetadataBag(metadata: unknown): { triggerId?: string; planRunId?: string } {
	if (typeof metadata !== "object" || metadata === null) return {};
	const bag = metadata as Record<string, unknown>;
	const out: { triggerId?: string; planRunId?: string } = {};
	if (typeof bag.triggerId === "string" && bag.triggerId !== "") out.triggerId = bag.triggerId;
	if (typeof bag.planRunId === "string" && bag.planRunId !== "") out.planRunId = bag.planRunId;
	return out;
}

async function recordWriteFailedEvent(
	repos: Repos,
	runId: string,
	now: Date,
	reason: string,
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: now.toISOString(),
			kind: "dispatch_context_write_failed",
			stream: "system",
			payload: { reason },
		});
	} catch {
		// Logging failure must not surface — same posture as seed-extensions.
	}
}
