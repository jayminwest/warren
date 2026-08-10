import { ValidationError } from "../../../core/errors.ts";
import { readProviderFrontmatter } from "../../../registry/schema.ts";
import { readMaxCostUsd } from "../../../runs/cost-cap.ts";
import { spawnRun } from "../../../runs/index.ts";
import type { IdempotentDispatch } from "../../idempotency.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { optionalObject, optionalPositiveNumber } from "../body-fields.ts";
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
	const rendered = parent.renderedAgentJson as { frontmatter?: Record<string, unknown> };
	const fm = readProviderFrontmatter(rendered.frontmatter ?? {});
	// warren-a63d: the parent's EFFECTIVE cap (whichever tier supplied it) sits
	// folded on the frozen frontmatter; read it back so the replica inherits it
	// verbatim, same as provider/model.
	const capUsd = readMaxCostUsd(rendered.frontmatter ?? {});
	return {
		agentName: parent.agentName,
		projectId: parent.projectId,
		prompt: parent.prompt,
		...(fm.provider !== undefined ? { providerOverride: fm.provider } : {}),
		...(fm.model !== undefined ? { modelOverride: fm.model } : {}),
		...(capUsd !== null ? { maxCostUsd: capUsd } : {}),
	};
}

/**
 * Resolved chain + identity fields for a `POST /runs` dispatch
 * (warren-4b11 + warren-e96f). Factored out of `createRunHandler` to keep
 * the handler's cognitive complexity under the project ceiling: the
 * continuation/replicate fallbacks add several `??` chains that all collapse
 * here.
 */
interface ResolvedDispatchFields {
	readonly agentName: string;
	readonly projectId: string;
	readonly prompt: string;
	readonly providerOverride?: string;
	readonly modelOverride?: string;
	readonly maxCostUsd?: number;
	readonly parentRunId?: string;
	readonly cloneKind?: "replicate";
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
	const clone =
		continueFromRunId === undefined && cloneFromRunId !== undefined
			? await resolveCloneDefaults(deps, cloneFromRunId)
			: undefined;

	return {
		agentName: optionalString(body, "agent") ?? clone?.agentName ?? requireString(body, "agent"),
		projectId:
			optionalString(body, "project") ?? clone?.projectId ?? requireString(body, "project"),
		prompt: optionalString(body, "prompt") ?? clone?.prompt ?? requireString(body, "prompt"),
		providerOverride: optionalString(body, "providerOverride") ?? clone?.providerOverride,
		modelOverride: optionalString(body, "modelOverride") ?? clone?.modelOverride,
		// Per-dispatch spend cap (warren-a63d): explicit body field wins; a
		// replicate falls back to the parent's effective cap read off its
		// frozen frontmatter, matching the provider/model inheritance above.
		maxCostUsd: optionalPositiveNumber(body, "maxCostUsd") ?? clone?.maxCostUsd,
		// A replicate records the same `parent_run_id` column as a continuation;
		// the `clone_kind` discriminator keeps them apart.
		...(continueFromRunId !== undefined ? { parentRunId: continueFromRunId } : {}),
		...(clone !== undefined && cloneFromRunId !== undefined
			? { parentRunId: cloneFromRunId, cloneKind: "replicate" as const }
			: {}),
	};
}

export function createRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const seedId = optionalString(body, "seedId");
		const ref = optionalString(body, "ref");
		// warren-709e (#419): an explicit target branch the run must push to
		// instead of the composed `${prefix}/${runId}`. Persisted on the run row
		// and used both to pin the burrow workspace branch (composeRunBranch) and
		// to default the root-run base ref when no `ref` is supplied.
		const targetBranch = optionalString(body, "targetBranch");
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
			parentRunId,
			cloneKind,
		} = await resolveDispatchFields(deps, body);

		const options: Parameters<typeof spawnRun>[0] = {
			repos: deps.repos,
			// warren-245d: thread the resolved runtime provider so POST /runs
			// dispatches through the K8sProvider under WARREN_RUNTIME=k8s. Without
			// this, spawnRun fell back to the burrow LocalProvider and every K8s
			// dispatch 503'd `burrow_unreachable`. Mirrors conversations.ts.
			runtimeProvider: deps.runtimeProvider,
			agentName,
			projectId,
			prompt,
			mode: "batch",
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			githubToken: deps.autoOpenPr?.gitToken,
			// warren-b27c: shape-checked, not cast. An array or scalar `metadata`
			// used to sail through the cast and reach persistence typed as a record.
			metadata: optionalObject(body, "metadata"),
			now: deps.now,
			ref,
			providerOverride,
			modelOverride,
			...(trigger !== undefined ? { trigger } : {}),
			...(maxCostUsd !== undefined ? { maxCostUsdOverride: maxCostUsd } : {}),
			seedId,
			...(targetBranch !== undefined ? { targetBranch } : {}),
			...(parentRunId !== undefined ? { parentRunId } : {}),
			...(cloneKind !== undefined ? { cloneKind } : {}),
			dispatcherHandle,
			warrenConfigs: deps.warrenConfigs,
			runBranchPrefixDefault: deps.runBranchPrefixDefault,
			seedsCli: deps.seedsCli,
			logger: ctx.logger,
		};

		// warren-d525: the real dispatch — spawn and attach the bridge. Wrapped
		// so the idempotency store can run it at most once per (projectId, key),
		// keeping every side effect (spawn + bridge start) deduped.
		const dispatch = async (): Promise<IdempotentDispatch> => {
			const result = await spawnRun(options);
			deps.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);
			return {
				run: result.run,
				burrow: { id: result.burrow.id, workspacePath: result.burrow.workspacePath },
			};
		};

		// `Idempotency-Key` present + a store wired → dedupe duplicate
		// deliveries of one logical dispatch (proxy/LB replay, scheduler
		// double-fire, client re-retry). Absent header preserves the
		// always-spawn behavior for backward compat.
		const idempotencyKey = ctx.request.headers.get("Idempotency-Key") ?? "";
		const dispatched =
			idempotencyKey !== "" && deps.idempotencyStore !== undefined
				? await deps.idempotencyStore.run(projectId, idempotencyKey, dispatch)
				: await dispatch();

		return jsonResponse(201, dispatched);
	};
}
