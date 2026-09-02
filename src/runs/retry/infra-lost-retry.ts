/**
 * Automatic retry for infra-lost runs (warren-4af7).
 *
 * A run that terminalizes `failed` with an infra-lost failure reason
 * (`sandbox_run_lost` — the sandbox/pod vanished under a healthy run: burrow
 * 404s the run, a GC'd pod, a lost worker) says nothing about the prompt,
 * the seed, or the agent — the failure is in the substrate. Warren therefore
 * dispatches ONE replacement run automatically:
 *
 *   - The retry is a NEW run id linked to the original via `runs.retry_of`
 *     (wired through the schema, `SpawnRunInput.retryOf`, and the SDK/UI
 *     run projections). No attempt counter on the row — the link field IS
 *     the budget: a run whose `retryOf` is set (it IS a retry), or that
 *     already has a retry pointing at it, earns no further automatic retry.
 *     If the retry itself lands infra-lost, it stays terminal.
 *   - Spend is cumulative: the retry inherits the original run's resolved
 *     cost cap MINUS the first attempt's recorded spend, folded onto the
 *     dispatch-override slot (`maxCostUsdOverride`) so the event bridge
 *     enforces one shrinking ceiling across both attempts — no fresh
 *     budget. An exhausted budget (remaining <= 0) means no retry.
 *   - Plan-run children are EXCLUDED here: the coordinator's own child
 *     retry (warren-6de9, `src/plan-runs/retry.ts`) owns them — this module
 *     appended the infra-lost cause to `RETRYABLE_CHILD_FAILURE_REASONS`,
 *     and the run-level hook stands down via `planRuns.findChildByRunId`
 *     so a child never double-retries.
 *
 * The hook is fired from the two places a run can terminalize infra-lost:
 * `reapRun` (watchdog terminal-reconcile, inline bridge reap) and
 * `reconcileLostSandboxRun` (live-bridge 404, boot ghost reconcile). The
 * user-initiated cancel ghost path (`src/runs/cancel.ts`) deliberately does
 * NOT fire it — an operator who clicked Cancel asked for no new run.
 *
 * Linkage is observable both directions: the original run's stream gets
 * `run.retry_dispatched` (naming the new run id) and the retry's stream
 * opens with `run.retry_of` (naming the original), so an operator tailing
 * either run can follow the chain.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { RunFailureReason, RunRow } from "../../db/schema.ts";
import type { Forge } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import type { SpawnFn as ProjectSpawnFn } from "../../projects/clone.ts";
import type { ProjectsConfig } from "../../projects/config.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import type { GitSpawnCredential } from "../../workspace/git/credential-env.ts";
import { resolveCostCapUsd } from "../cost-cap.ts";
import type { RunEventBroker } from "../events.ts";
import { spawnRun } from "../spawn/dispatch.ts";
import type { SpawnRunInput } from "../spawn/types.ts";
import type { BridgeLogger } from "../stream/index.ts";
import { bindBridgeLogger } from "../stream/index.ts";
import type { BridgeRegistry } from "../stream/types.ts";
import { inheritedDispatchOverrides } from "./inherited-overrides.ts";

/**
 * Failure causes that justify one automatic run-level re-dispatch. Today
 * exactly one: the substrate lost the run. Kept as a list (mirroring
 * `RETRYABLE_CHILD_FAILURE_REASONS`) so a second infra-lost cause joins by
 * appending, per the warren-6de9 factored-shape precedent.
 */
export const INFRA_LOST_RUN_FAILURE_REASONS = [
	"sandbox_run_lost",
	// warren-ea4b: Spot preemption — the pod died because GKE reclaimed its
	// node, not because of anything in the prompt or seed. Same single-retry
	// posture as `sandbox_run_lost`.
	"preempted",
] as const satisfies readonly RunFailureReason[];

export type InfraLostRunFailureReason = (typeof INFRA_LOST_RUN_FAILURE_REASONS)[number];

/** Is this run failure cause an infra-lost one worth one automatic retry? */
export function isInfraLostRunFailure(
	reason: RunFailureReason | null,
): reason is InfraLostRunFailureReason {
	return reason !== null && (INFRA_LOST_RUN_FAILURE_REASONS as readonly string[]).includes(reason);
}

/** Event kinds recording the retry linkage on each side of the chain. */
export const RUN_RETRY_DISPATCHED_KIND = "run.retry_dispatched";
export const RUN_RETRY_OF_KIND = "run.retry_of";

/**
 * The run-level infra-lost retry hook. Boot wires it once and threads it
 * into reap + the lost-run reconciler; fire-and-log semantics — a hook
 * failure must never wedge the terminalization that fired it.
 */
export type InfraLostRetryHook = (runId: string) => Promise<void>;

/** Why a candidate run did NOT earn an automatic retry (log/event detail). */
export type InfraLostRetrySkip =
	| "not_infra_lost"
	| "is_retry"
	| "already_retried"
	| "plan_run_child"
	| "no_project"
	| "budget_exhausted";

export interface InfraLostRetryDecision {
	readonly retry: boolean;
	readonly skip?: InfraLostRetrySkip;
	/**
	 * The cap the retry dispatch inherits: the original run's resolved cap
	 * minus its recorded spend. `null` when the original had no cap (the
	 * retry then dispatches with no override, exactly like the original).
	 */
	readonly remainingBudgetUsd: number | null;
}

/**
 * The single retry decision, pure over the run row plus two lookups:
 * retry iff the run failed infra-lost, is not itself a retry, has not
 * already spawned one, is not a plan-run child (the coordinator's shape
 * owns those), still belongs to a project, and has budget left.
 */
export async function decideInfraLostRetry(
	repos: Repos,
	run: RunRow,
): Promise<InfraLostRetryDecision> {
	const no = (skip: InfraLostRetrySkip, remainingBudgetUsd: number | null = null) => ({
		retry: false,
		skip,
		remainingBudgetUsd,
	});
	if (run.state !== "failed" || !isInfraLostRunFailure(run.failureReason)) {
		return no("not_infra_lost");
	}
	// The retry-of link IS the budget: a retry that lands infra-lost stays
	// terminal, and an original that already spawned one is spent.
	if (run.retryOf !== null) return no("is_retry");
	if ((await repos.runs.findByRetryOf(run.id)) !== null) return no("already_retried");
	// A plan-run child is covered by the coordinator's child retry
	// (warren-6de9 shape + the infra-lost cause appended in warren-4af7) —
	// the run-level hook must not double-dispatch it.
	if ((await repos.planRuns.findChildByRunId(run.id)) !== null) return no("plan_run_child");
	if (run.projectId === null) return no("no_project");
	// Cumulative spend: the retry inherits the original cap minus what the
	// first attempt already burned. Null cap ⇒ uncapped ⇒ null remaining.
	const cap = resolveCostCapUsd(run.renderedAgentJson);
	const remaining = cap === null ? null : cap - (run.costUsd ?? 0);
	if (remaining !== null && remaining <= 0) return no("budget_exhausted", remaining);
	return { retry: true, remainingBudgetUsd: remaining };
}

/** Writable draft of the retry's {@link SpawnRunInput} (the input type is readonly). */
type RetrySpawnDraft = {
	-readonly [K in keyof SpawnRunInput]?: SpawnRunInput[K];
};

/**
 * Map a failed infra-lost run onto the spawn input for its ONE retry: same
 * agent/project/prompt/seed/trigger/mode/ref, `retryOf` back-link set, and
 * the remaining budget on the dispatch-override slot (warren-4af7:
 * cumulative spend — the retry's cap is what the original cap has LEFT;
 * omitted when the original was uncapped, so the retry resolves caps
 * exactly as the original did). Linear if-chains keep this under the
 * cognitive-complexity ceiling where conditional spreads would not.
 */
function buildRetrySpawnInput(
	gitCredential: GitSpawnCredential | undefined,
	input: CreateInfraLostRetryHookInput,
	run: RunRow,
	projectId: string,
	decision: InfraLostRetryDecision,
): SpawnRunInput {
	const draft: RetrySpawnDraft = {
		...(gitCredential !== undefined ? { gitCredential } : {}),
		repos: input.repos,
		runtimeProvider: input.runtimeProvider,
		agentName: run.agentName,
		projectId,
		prompt: run.prompt,
		// trigger is inherited from the original (lossy for provenance) —
		// dispatchOrigin is the explicit "this row is an infra-lost retry"
		// stamp (warren-9ce3).
		trigger: run.trigger,
		dispatchOrigin: "retry_infra_lost",
		mode: run.mode,
		retryOf: run.id,
	};
	if (run.seedId !== null) draft.seedId = run.seedId;
	if (run.ref !== null) draft.ref = run.ref;
	if (run.baseCommit !== null) draft.baseCommit = run.baseCommit;
	if (run.targetBranch !== null) draft.targetBranch = run.targetBranch;
	// warren-0d80: provider and model come off the original's frozen
	// frontmatter, so the retry runs on what the operator selected rather than
	// on whatever the agent and project defaults resolve to now.
	const inherited = inheritedDispatchOverrides(run.renderedAgentJson);
	if (inherited.providerOverride !== undefined) draft.providerOverride = inherited.providerOverride;
	if (inherited.modelOverride !== undefined) draft.modelOverride = inherited.modelOverride;
	// The cap is deliberately NOT taken from `inherited`. warren-4af7 gives
	// this retry the original cap MINUS what the first attempt spent, and the
	// full frozen cap would hand it a fresh budget.
	if (decision.remainingBudgetUsd !== null) draft.maxCostUsdOverride = decision.remainingBudgetUsd;
	if (input.projectsConfig !== undefined) draft.projectsConfig = input.projectsConfig;
	if (input.projectSpawn !== undefined) draft.projectSpawn = input.projectSpawn;
	if (input.warrenConfigs !== undefined) draft.warrenConfigs = input.warrenConfigs;
	if (input.seedsCli !== undefined) draft.seedsCli = input.seedsCli;
	if (input.issueTracker !== undefined) draft.issueTracker = input.issueTracker;
	if (input.runBranchPrefixDefault !== undefined) {
		draft.runBranchPrefixDefault = input.runBranchPrefixDefault;
	}
	if (input.now !== undefined) draft.now = input.now;
	return draft as SpawnRunInput;
}

export interface CreateInfraLostRetryHookInput {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	/**
	 * Bridge registry the retry's event stream attaches to. Late-bound at
	 * boot (the registry is created by `bootBridges`, which itself can fire
	 * the hook from the ghost-reconcile path), so this is a facade whose
	 * `start` delegates to a cell the boot wiring fills.
	 */
	readonly bridges: Pick<BridgeRegistry, "start">;
	/** Pre-dispatch clone refresh seams — same posture as `createPlanRunSpawn`. */
	readonly projectsConfig?: ProjectsConfig;
	readonly projectSpawn?: ProjectSpawnFn;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly seedsCli?: SeedsCliDeps;
	/** Boot-resolved IssueTracker (warren-5819) — threading seam for the retry spawn. */
	readonly issueTracker?: IssueTracker;
	/**
	 * Boot-resolved forge. The retry's pre-dispatch refresh fetch mints its
	 * credential HERE, per dispatch (forge-contract.md §4), rather than
	 * holding a boot-read `GITHUB_TOKEN` across the process lifetime.
	 */
	readonly forge?: Forge;
	readonly runBranchPrefixDefault?: string;
	/** Live tail fan-out for the linkage events; omit in tests. */
	readonly broker?: RunEventBroker;
	readonly now?: () => Date;
	readonly logger?: BridgeLogger;
	/** Test seam — defaults to the live `spawnRun`. */
	readonly spawnRunFn?: typeof spawnRun;
}

/**
 * Build the run-level infra-lost retry hook. The returned closure loads the
 * run, narrows against {@link decideInfraLostRetry}, re-dispatches the same
 * agent/project/prompt/seed with the remaining budget on the override slot,
 * attaches the retry's bridge, and emits the linkage events on both runs.
 * Skips are logged, never thrown; a spawn failure lands as a
 * `run.retry_failed` system event on the original run (the run stays
 * terminal — an operator can still re-dispatch by hand).
 */
export function createInfraLostRetryHook(input: CreateInfraLostRetryHookInput): InfraLostRetryHook {
	const spawnRunFn = input.spawnRunFn ?? spawnRun;
	const now = input.now ?? (() => new Date());
	const emitSystem = async (runId: string, kind: string, payload: unknown): Promise<void> => {
		const seq = ((await input.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: now().toISOString(),
			kind,
			stream: "system",
			payload,
		});
		input.broker?.publish(runId, row);
	};
	return async (runId: string): Promise<void> => {
		const log = bindBridgeLogger(input.logger, { run_id: runId });
		const run = await input.repos.runs.get(runId);
		if (run === null) return;
		const decision = await decideInfraLostRetry(input.repos, run);
		if (!decision.retry) {
			log.info(
				{ event: "run.retry_skipped", skip: decision.skip, failureReason: run.failureReason },
				"infra-lost run retry skipped",
			);
			return;
		}
		// Defensive narrowing for noUncheckedIndexedAccess: decideInfraLostRetry
		// already excluded a null projectId.
		const projectId = run.projectId;
		if (projectId === null) return;
		try {
			const project = await input.repos.projects.get(projectId);
			const gitCredential =
				input.forge !== undefined && project !== null
					? await mintGitCredential(input.forge, project.gitUrl)
					: undefined;
			const result = await spawnRunFn(
				buildRetrySpawnInput(gitCredential, input, run, projectId, decision),
			);
			input.bridges.start(result.run.id, result.sandboxRun.id, result.sandbox.id, run.mode);
			// Linkage in both directions so an operator tailing either run can
			// follow the chain (warren-4af7).
			await emitSystem(run.id, RUN_RETRY_DISPATCHED_KIND, {
				retryRunId: result.run.id,
				failureReason: run.failureReason,
				remainingBudgetUsd: decision.remainingBudgetUsd,
			});
			await emitSystem(result.run.id, RUN_RETRY_OF_KIND, {
				retryOf: run.id,
				failureReason: run.failureReason,
				remainingBudgetUsd: decision.remainingBudgetUsd,
			});
			log.info(
				{
					event: "run.retry_dispatched",
					retry_run_id: result.run.id,
					remainingBudgetUsd: decision.remainingBudgetUsd,
				},
				"infra-lost run auto-retried",
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await emitSystem(run.id, "run.retry_failed", { error: message });
			log.error({ event: "run.retry_failed", err: message }, "infra-lost run retry failed");
		}
	};
}
