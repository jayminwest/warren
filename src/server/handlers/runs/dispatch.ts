import { ValidationError } from "../../../core/errors.ts";
import { mintGitCredential } from "../../../forge/credentials.ts";
import { readProviderFrontmatter } from "../../../registry/schema.ts";
import { validateBaseCommit, validateDispatchRef } from "../../../runs/base-commit.ts";
import { readMaxCostUsd } from "../../../runs/cost-cap.ts";
import { spawnRun } from "../../../runs/index.ts";
import { readMaxDurationMinutes } from "../../../runs/run-timeout.ts";
import type { TrackerContext } from "../../../tracker/contract.ts";
import type { GitSpawnCredential } from "../../../workspace/git/credential-env.ts";
import type { IdempotentDispatch } from "../../idempotency.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { optionalObject, optionalPositiveInteger, optionalPositiveNumber } from "../body-fields.ts";
import { defaultSpawn, optionalString, readJsonBody, requireString } from "../index.ts";

/**
 * Defaults derived from a prior run for the `cloneFromRunId` re-run path
 * (warren-e96f). Every field is a fallback: an explicit body field on
 * `POST /runs` still wins, so the UI can prefill `/runs/new` and let the
 * operator tweak a knob, while a true one-click re-run sends only
 * `cloneFromRunId` and inherits the parent's config verbatim.
 */
interface CloneDefaults {
	readonly agentName: string;
	readonly projectId: string;
	readonly prompt: string;
	readonly providerOverride?: string;
	readonly modelOverride?: string;
	readonly maxCostUsd?: number;
	readonly maxDurationMinutes?: number;
}

/**
 * #1241 / warren-1db0: the resolved shape of a `rescueFromRunId` dispatch.
 * `CloneDefaults` plus the source run's frozen `salvageRef` rescue branch,
 * which becomes the dispatch's `existingBranch`.
 */
interface RescueDefaults extends CloneDefaults {
	readonly rescueRef: string;
}

/**
 * warren-6c4c: mint the spawn's clone-refresh credential per-spawn through
 * the boot forge (forge-contract.md §4); no config object holds a token.
 * Extracted so `createRunHandler`'s complexity budget stays intact.
 */
async function mintSpawnGitCredential(
	deps: ServerDeps,
	projectId: string,
): Promise<{ gitCredential?: GitSpawnCredential }> {
	const project = await deps.repos.projects.require(projectId);
	const secret = await mintGitCredential(deps.forge, project.gitUrl);
	return secret !== undefined ? { gitCredential: secret } : {};
}

/**
 * #1234: validate a dispatched `seedId` against the tracker before any
 * side effects. `IssueTracker.getIssue` throws `IssueNotFoundError` for a
 * missing id (same contract `readDispatchableIssues` in
 * `src/plan-runs/create.ts` relies on); `renderError` maps that to 404.
 * No tracker wired → skip, matching `resolveSeedTracker`'s existing
 * "neither wired -> no write" precedent for the post-dispatch metadata
 * write, so an untracked project's dispatch stays unaffected.
 */
async function validateSeedId(deps: ServerDeps, projectId: string, seedId: string): Promise<void> {
	if (deps.issueTracker === undefined) return;
	const project = await deps.repos.projects.require(projectId);
	const ctx: TrackerContext = { projectId: project.id, localPath: project.localPath };
	await deps.issueTracker.getIssue(ctx, seedId);
}

/**
 * Resolve the prior run referenced by `cloneFromRunId` into dispatch
 * defaults (warren-e96f). The effective provider/model are read back off the
 * parent's frozen `rendered_agent_json` so the replica fires onto the exact
 * same model the parent used, regardless of which slot (override vs project
 * default vs agent frontmatter) originally supplied it.
 */
async function resolveCloneDefaults(
	deps: ServerDeps,
	cloneFromRunId: string,
): Promise<CloneDefaults> {
	const parent = await deps.repos.runs.require(cloneFromRunId);
	if (parent.projectId === null) {
		throw new ValidationError(
			`run ${cloneFromRunId} has no project; cannot re-run a run whose project was deleted`,
		);
	}
	return readParentDefaults({
		agentName: parent.agentName,
		projectId: parent.projectId,
		prompt: parent.prompt,
		renderedAgentJson: parent.renderedAgentJson,
	});
}

/**
 * #1241 / warren-1db0: resolve the source run referenced by `rescueFromRunId`
 * into dispatch defaults plus its salvage rescue branch. The branch is stamped
 * by the reap salvage path (`runs.salvage_ref`, `warren/rescue/<runId>` on
 * origin); a run with none has nothing to re-dispatch from, so the dispatch is
 * refused with 400 before any side effect. Everything else inherits from the
 * source run the same way `resolveCloneDefaults` does.
 */
async function resolveRescueDefaults(
	deps: ServerDeps,
	rescueFromRunId: string,
): Promise<RescueDefaults> {
	const parent = await deps.repos.runs.require(rescueFromRunId);
	if (parent.projectId === null) {
		throw new ValidationError(
			`run ${rescueFromRunId} has no project; cannot rescue a run whose project was deleted`,
		);
	}
	if (parent.salvageRef === null || parent.salvageRef === "") {
		throw new ValidationError(`run ${rescueFromRunId} has no rescue branch to re-dispatch from`, {
			recoveryHint:
				"The run's work was never salvaged (no warren/rescue/<runId> branch on origin). " +
				"Dispatch a fresh run, or continue from it with continueFromRunId if it pushed a branch.",
		});
	}
	return {
		...readParentDefaults({
			agentName: parent.agentName,
			projectId: parent.projectId,
			prompt: parent.prompt,
			renderedAgentJson: parent.renderedAgentJson,
		}),
		rescueRef: parent.salvageRef,
	};
}

/**
 * Inherited dispatch defaults read off a prior run's frozen row — shared by
 * the `cloneFromRunId` replicate path (warren-e96f) and the `rescueFromRunId`
 * rescue path (#1241). The effective provider/model/cap are read back off the
 * frozen `rendered_agent_json` so the follow-up fires onto the exact same
 * model the parent used, regardless of which slot originally supplied it.
 */
function readParentDefaults(parent: {
	agentName: string;
	projectId: string;
	prompt: string;
	renderedAgentJson: unknown;
}): CloneDefaults {
	const rendered = parent.renderedAgentJson as { frontmatter?: Record<string, unknown> };
	const fm = readProviderFrontmatter(rendered.frontmatter ?? {});
	// warren-a63d: the parent's EFFECTIVE cap (whichever tier supplied it) sits
	// folded on the frozen frontmatter; read it back so the follow-up inherits it
	// verbatim, same as provider/model.
	const capUsd = readMaxCostUsd(rendered.frontmatter ?? {});
	// warren-a112: the wall-clock cap is inherited the same way.
	const capMinutes = readMaxDurationMinutes(rendered.frontmatter ?? {});
	return {
		agentName: parent.agentName,
		projectId: parent.projectId,
		prompt: parent.prompt,
		...(fm.provider !== undefined ? { providerOverride: fm.provider } : {}),
		...(fm.model !== undefined ? { modelOverride: fm.model } : {}),
		...(capUsd !== null ? { maxCostUsd: capUsd } : {}),
		...(capMinutes !== null ? { maxDurationMinutes: capMinutes } : {}),
	};
}

/**
 * Resolved chain + identity fields for a `POST /runs` dispatch
 * (warren-4b11 + warren-e96f). Factored out of `createRunHandler` to keep
 * the handler's cognitive complexity under the project ceiling: the
 * continuation/replicate fallbacks add several `??` chains that all collapse
 * here.
 */
/**
 * #1241: `rescueFromRunId` resolves its own base (the source run's salvage
 * rescue branch), so it is mutually exclusive with the other base-resolving
 * dispatch fields. Refused with 400 before any side effect.
 */
function assertRescueExclusivity(
	body: Record<string, unknown>,
	fields: {
		continueFromRunId: string | undefined;
		cloneFromRunId: string | undefined;
		rescueFromRunId: string | undefined;
	},
): void {
	if (fields.rescueFromRunId === undefined) return;
	const explicitExistingBranch = optionalString(body, "existingBranch");
	const conflicts = [
		...(fields.continueFromRunId !== undefined ? ["continueFromRunId"] : []),
		...(fields.cloneFromRunId !== undefined ? ["cloneFromRunId"] : []),
		...(explicitExistingBranch !== undefined ? ["existingBranch"] : []),
	];
	if (conflicts.length === 0) return;
	throw new ValidationError(`rescueFromRunId cannot be combined with: ${conflicts.join(", ")}`, {
		recoveryHint:
			"rescueFromRunId resolves the base branch itself (the source run's " +
			"salvage rescue branch). Dispatch it on its own.",
	});
}

/**
 * Per-dispatch caps: the spend cap (warren-a63d) and the wall-clock cap
 * (warren-a112). An explicit body field wins; a replicate or rescue falls
 * back to the source run's effective cap read off its frozen frontmatter,
 * matching the provider/model inheritance. Undefined keys are omitted.
 */
function resolveDispatchCaps(
	body: Record<string, unknown>,
	source: CloneDefaults | undefined,
): { maxCostUsd?: number; maxDurationMinutes?: number } {
	const maxCostUsd = optionalPositiveNumber(body, "maxCostUsd") ?? source?.maxCostUsd;
	const maxDurationMinutes =
		optionalPositiveInteger(body, "maxDurationMinutes") ?? source?.maxDurationMinutes;
	return {
		...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
		...(maxDurationMinutes !== undefined ? { maxDurationMinutes } : {}),
	};
}

interface ResolvedDispatchFields extends CloneDefaults {
	readonly parentRunId?: string;
	readonly cloneKind?: "replicate" | "rescue";
	/** #1241: the source run's rescue branch, dispatched as `existingBranch`. */
	readonly rescueRef?: string;
}

async function resolveDispatchFields(
	deps: ServerDeps,
	body: Record<string, unknown>,
): Promise<ResolvedDispatchFields> {
	// warren-4b11: "re-run with follow-up" — base the workspace on the prior
	// run's pushed branch. Accept both `continueFromRunId` (the UI affordance
	// name) and `parentRunId` (the column name); the former wins.
	const continueFromRunId =
		optionalString(body, "continueFromRunId") ?? optionalString(body, "parentRunId");
	// warren-e96f: "re-run from scratch" — replicate the prior run's exact
	// agent / model / project / prompt against the project default base.
	// Mutually exclusive with the continuation path; continuation wins.
	const cloneFromRunId = optionalString(body, "cloneFromRunId");
	// #1241 / warren-1db0: "dispatch from the rescue" — re-dispatch a salvaged
	// run's recovered work off its `warren/rescue/<runId>` branch.
	const rescueFromRunId = optionalString(body, "rescueFromRunId");
	assertRescueExclusivity(body, {
		continueFromRunId,
		cloneFromRunId,
		rescueFromRunId,
	});
	const rescue =
		rescueFromRunId !== undefined ? await resolveRescueDefaults(deps, rescueFromRunId) : undefined;
	const clone =
		continueFromRunId === undefined && rescue === undefined && cloneFromRunId !== undefined
			? await resolveCloneDefaults(deps, cloneFromRunId)
			: undefined;

	return {
		agentName:
			optionalString(body, "agent") ??
			rescue?.agentName ??
			clone?.agentName ??
			requireString(body, "agent"),
		projectId:
			optionalString(body, "project") ??
			rescue?.projectId ??
			clone?.projectId ??
			requireString(body, "project"),
		prompt:
			optionalString(body, "prompt") ??
			rescue?.prompt ??
			clone?.prompt ??
			requireString(body, "prompt"),
		providerOverride:
			optionalString(body, "providerOverride") ??
			rescue?.providerOverride ??
			clone?.providerOverride,
		modelOverride:
			optionalString(body, "modelOverride") ?? rescue?.modelOverride ?? clone?.modelOverride,
		...resolveDispatchCaps(body, rescue ?? clone),
		// A replicate or rescue records the same `parent_run_id` column as a
		// continuation; the `clone_kind` discriminator keeps them apart.
		...(continueFromRunId !== undefined ? { parentRunId: continueFromRunId } : {}),
		...(clone !== undefined && cloneFromRunId !== undefined
			? { parentRunId: cloneFromRunId, cloneKind: "replicate" as const }
			: {}),
		...(rescue !== undefined && rescueFromRunId !== undefined
			? { parentRunId: rescueFromRunId, cloneKind: "rescue" as const, rescueRef: rescue.rescueRef }
			: {}),
	};
}

/**
 * Assemble the `spawnRun` input bag for `POST /runs` (warren-9ce3 origin +
 * optional field forwarding). Extracted so `createRunHandler`'s request
 * body stays under the cognitive-complexity ceiling.
 */
async function buildHttpSpawnOptions(
	deps: ServerDeps,
	body: Record<string, unknown>,
	logger: Parameters<typeof spawnRun>[0]["logger"],
): Promise<Parameters<typeof spawnRun>[0]> {
	const seedId = optionalString(body, "seedId");
	// warren-aaf7: the base-commit pin split. `ref` must stay branch-shaped
	// (it feeds the PR base at reap); a SHA belongs in `baseCommit`, which
	// overrides only the workspace cut point.
	const ref = validateDispatchRef(optionalString(body, "ref"));
	const baseCommit = validateBaseCommit(optionalString(body, "baseCommit"));
	// warren-709e (#419): an explicit target branch the run must push to
	// instead of the composed `${prefix}/${runId}`.
	const targetBranch = optionalString(body, "targetBranch");
	// warren-326f: opt-in dispatch onto an existing push-remote branch. The
	// fail-closed remote-existence check lives in spawnRun (domain layer), so
	// the handler only forwards the field. #1241: a `rescueFromRunId` dispatch
	// resolves to this same field (the source run's salvage rescue branch), so
	// the domain path — shape validation, remote probe, push-back, no PR — is
	// the one warren-326f already owns.
	const existingBranch = optionalString(body, "existingBranch");
	const dispatcherHandle = optionalString(body, "dispatcherHandle");
	// warren-97a2: the HTTP-collapsed `warren run` labels its dispatches
	// trigger=cli; omitting the field preserves the spawnRun default.
	const trigger = optionalString(body, "trigger");
	const {
		agentName,
		projectId,
		prompt,
		providerOverride,
		modelOverride,
		maxCostUsd,
		maxDurationMinutes,
		parentRunId,
		cloneKind,
		rescueRef,
	} = await resolveDispatchFields(deps, body);
	// #1241: the rescue branch wins over an explicit `existingBranch` (the two
	// fields are mutually exclusive — checked above), and rides the identical
	// existing-branch domain path.
	const effectiveExistingBranch = rescueRef ?? existingBranch;

	if (seedId !== undefined) await validateSeedId(deps, projectId, seedId);

	// warren-9ce3: trigger=cli → origin "cli"; every other POST /runs is "api".
	const dispatchOrigin = trigger === "cli" ? "cli" : "api";
	return {
		repos: deps.repos,
		// warren-245d: thread the resolved runtime provider so POST /runs
		// dispatches through the K8sProvider under WARREN_RUNTIME=k8s.
		runtimeProvider: deps.runtimeProvider,
		agentName,
		projectId,
		prompt,
		mode: "batch",
		projectsConfig: deps.projectsConfig,
		projectSpawn: deps.spawn ?? defaultSpawn,
		...(await mintSpawnGitCredential(deps, projectId)),
		// warren-b27c: shape-checked, not cast.
		metadata: optionalObject(body, "metadata"),
		now: deps.now,
		ref,
		// warren-aaf7: workspace cut override; never reaches PR-base resolution.
		...(baseCommit !== undefined ? { baseCommit } : {}),
		providerOverride,
		modelOverride,
		...(trigger !== undefined ? { trigger } : {}),
		...(maxCostUsd !== undefined ? { maxCostUsdOverride: maxCostUsd } : {}),
		...(maxDurationMinutes !== undefined ? { maxDurationMinutesOverride: maxDurationMinutes } : {}),
		seedId,
		...(targetBranch !== undefined ? { targetBranch } : {}),
		...(effectiveExistingBranch !== undefined ? { existingBranch: effectiveExistingBranch } : {}),
		...(parentRunId !== undefined ? { parentRunId } : {}),
		...(cloneKind !== undefined ? { cloneKind } : {}),
		dispatcherHandle,
		dispatchOrigin,
		warrenConfigs: deps.warrenConfigs,
		runBranchPrefixDefault: deps.runBranchPrefixDefault,
		seedsCli: deps.seedsCli,
		...(deps.issueTracker !== undefined ? { issueTracker: deps.issueTracker } : {}),
		logger,
	};
}

export function createRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const options = await buildHttpSpawnOptions(deps, body, ctx.logger);

		// warren-d525: the real dispatch — spawn and attach the bridge. Wrapped
		// so the idempotency store can run it at most once per (projectId, key),
		// keeping every side effect (spawn + bridge start) deduped.
		const dispatch = async (): Promise<IdempotentDispatch> => {
			const result = await spawnRun(options);
			deps.bridges.start(result.run.id, result.sandboxRun.id, result.sandbox.id);
			return {
				run: result.run,
				sandbox: { id: result.sandbox.id, workspacePath: result.sandbox.workspacePath },
			};
		};

		// `Idempotency-Key` present + a store wired → dedupe duplicate
		// deliveries of one logical dispatch (proxy/LB replay, scheduler
		// double-fire, client re-retry). Absent header preserves the
		// always-spawn behavior for backward compat.
		const idempotencyKey = ctx.request.headers.get("Idempotency-Key") ?? "";
		const dispatched =
			idempotencyKey !== "" && deps.idempotencyStore !== undefined
				? await deps.idempotencyStore.run(options.projectId, idempotencyKey, dispatch)
				: await dispatch();

		return jsonResponse(201, dispatched);
	};
}
