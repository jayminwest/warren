import { join } from "node:path";
import { ValidationError } from "../../../core/errors.ts";
import { readProviderFrontmatter } from "../../../registry/schema.ts";
import {
	appendUserMessage,
	buildInteractivePrompt,
	defaultPlotContextReader,
	resolveDispatcherHandle,
	spawnInteractiveTurn,
	spawnRun,
} from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import {
	assertPlotIdDispatchable,
	defaultSpawn,
	optionalString,
	readJsonBody,
	requireParam,
	requireString,
} from "../index.ts";

/**
 * Parse the optional `mode` body field on `POST /runs` (pl-0344 step 4 /
 * warren-b3b9). Defaults to `'batch'` so existing single-shot dispatch
 * callers are byte-identical. `'interactive'` opts in to the
 * respawn-per-turn primitive (`src/runs/interactive.ts`); when set,
 * `plotId` is required and `interactiveAgent` may override `agent`.
 */
function parseRunMode(body: Record<string, unknown>): "batch" | "interactive" {
	const raw = body.mode;
	if (raw === undefined || raw === null) return "batch";
	if (raw !== "batch" && raw !== "interactive") {
		throw new ValidationError(
			`field 'mode' must be 'batch' or 'interactive'; got ${JSON.stringify(raw)}`,
		);
	}
	return raw;
}

async function validateDispatchPlotAndMode(
	mode: "batch" | "interactive",
	plotId: string | undefined,
	resolver: import("../../../plots/index.ts").PlotResolver | undefined,
): Promise<void> {
	await assertPlotIdDispatchable({ plotId, plotResolver: resolver });

	if (mode === "interactive" && (plotId === undefined || plotId === "")) {
		throw new ValidationError(
			"plotId is required when mode='interactive'; interactive runs bind to a Plot",
			{
				recoveryHint: "either pass plotId on POST /runs, or omit `mode` to dispatch a batch run",
			},
		);
	}
}

async function buildDispatchedPrompt(
	mode: "batch" | "interactive",
	plotId: string | undefined,
	prompt: string,
	projectId: string,
	dispatcherHandle: string | undefined,
	deps: ServerDeps,
): Promise<string> {
	if (mode !== "interactive" || plotId === undefined || plotId === "") {
		return prompt;
	}
	try {
		const project = await deps.repos.projects.require(projectId);
		const handle = resolveDispatcherHandle(dispatcherHandle);
		const context = await defaultPlotContextReader.read({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			historyTail: 0,
			handle,
		});
		return buildInteractivePrompt(context, prompt);
	} catch {
		return prompt;
	}
}

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
	return {
		agentName: parent.agentName,
		projectId: parent.projectId,
		prompt: parent.prompt,
		...(fm.provider !== undefined ? { providerOverride: fm.provider } : {}),
		...(fm.model !== undefined ? { modelOverride: fm.model } : {}),
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
	readonly parentRunId?: string;
	readonly cloneKind?: "replicate";
}

async function resolveDispatchFields(
	deps: ServerDeps,
	body: Record<string, unknown>,
	mode: "batch" | "interactive",
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

	const interactiveAgent = optionalString(body, "interactiveAgent");
	const agentName =
		mode === "interactive" && interactiveAgent !== undefined
			? interactiveAgent
			: (optionalString(body, "agent") ?? clone?.agentName ?? requireString(body, "agent"));

	return {
		agentName,
		projectId:
			optionalString(body, "project") ?? clone?.projectId ?? requireString(body, "project"),
		prompt: optionalString(body, "prompt") ?? clone?.prompt ?? requireString(body, "prompt"),
		providerOverride: optionalString(body, "providerOverride") ?? clone?.providerOverride,
		modelOverride: optionalString(body, "modelOverride") ?? clone?.modelOverride,
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
		const mode = parseRunMode(body);
		const seedId = optionalString(body, "seedId");
		const plotId = optionalString(body, "plotId");
		const ref = optionalString(body, "ref");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		const {
			agentName,
			projectId,
			prompt,
			providerOverride,
			modelOverride,
			parentRunId,
			cloneKind,
		} = await resolveDispatchFields(deps, body, mode);

		await validateDispatchPlotAndMode(mode, plotId, deps.plotResolver);

		const dispatchedPrompt = await buildDispatchedPrompt(
			mode,
			plotId,
			prompt,
			projectId,
			dispatcherHandle,
			deps,
		);

		const options: Parameters<typeof spawnRun>[0] = {
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			agentName,
			projectId,
			prompt: dispatchedPrompt,
			mode,
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			metadata: body.metadata as Record<string, unknown> | undefined,
			now: deps.now,
			ref,
			providerOverride,
			modelOverride,
			seedId,
			plotId,
			...(parentRunId !== undefined ? { parentRunId } : {}),
			...(cloneKind !== undefined ? { cloneKind } : {}),
			dispatcherHandle,
			warrenConfigs: deps.warrenConfigs,
			runBranchPrefixDefault: deps.runBranchPrefixDefault,
			seedsCli: deps.seedsCli,
		};

		const result = await spawnRun(options);

		if (mode === "interactive") {
			await appendUserMessage({
				repos: deps.repos,
				runId: result.run.id,
				message: prompt,
				handle: resolveDispatcherHandle(dispatcherHandle),
				...(deps.now !== undefined ? { now: deps.now() } : {}),
			});
		}

		deps.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);
		return jsonResponse(201, {
			run: result.run,
			burrow: { id: result.burrow.id, workspacePath: result.burrow.workspacePath },
		});
	};
}

/**
 * `POST /runs/:id/messages` — send a follow-up user turn on an
 * interactive conversation (pl-0344 step 4 / warren-b3b9).
 *
 * `:id` is the conversation handle — any prior interactive run row that
 * shares the same plotId works (the handler resolves the plot context
 * from disk, not from this row). Returns **202 Accepted** with the
 * freshly-spawned turn row + burrow descriptor + user_message event:
 * the dispatch is async (the agent reply lands later as an
 * `agent_message` event captured at reap), and 202 is the canonical
 * "queued for processing, see events stream for completion" shape.
 *
 * Body: `{message: string, dispatcherHandle?: string, providerOverride?,
 * modelOverride?, ref?}`. Field shape mirrors `POST /runs` so a UI
 * surface can reuse its dispatch plumbing.
 *
 * Errors:
 *   - 400 `validation_error` — missing/empty message, prior run is not
 *     mode='interactive', prior run has no plot_id, message is empty.
 *   - 404 `not_found` — prior run id doesn't exist.
 *
 * The follow-up turn is registered with the bridge the same way `POST
 * /runs` does, so its events flow onto warren's stream immediately.
 */
export function postRunMessageHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const message = requireString(body, "message");
		const dispatcherHandle = optionalString(body, "dispatcherHandle");
		const providerOverride = optionalString(body, "providerOverride");
		const modelOverride = optionalString(body, "modelOverride");
		const ref = optionalString(body, "ref");

		const options: Parameters<typeof spawnInteractiveTurn>[0] = {
			runId: id,
			message,
			repos: deps.repos,
			burrowClientPool: deps.burrowClientPool,
			trigger: "interactive",
			projectsConfig: deps.projectsConfig,
			projectSpawn: deps.spawn ?? defaultSpawn,
			ref,
			providerOverride,
			modelOverride,
			dispatcherHandle,
			now: deps.now,
			warrenConfigs: deps.warrenConfigs,
			runBranchPrefixDefault: deps.runBranchPrefixDefault,
			seedsCli: deps.seedsCli,
		};

		const result = await spawnInteractiveTurn(options);

		deps.bridges.start(result.turn.run.id, result.turn.burrowRun.id, result.turn.burrow.id);

		return jsonResponse(202, {
			run: result.turn.run,
			burrow: {
				id: result.turn.burrow.id,
				workspacePath: result.turn.burrow.workspacePath,
			},
			userMessageEvent: {
				id: result.userMessageEvent.id,
				runId: result.userMessageEvent.runId,
				seq: result.userMessageEvent.burrowEventSeq,
				ts: result.userMessageEvent.ts,
				kind: result.userMessageEvent.kind,
			},
			priorRunId: result.priorRun.id,
			plotContextDegraded: result.plotContextDegraded,
		});
	};
}
