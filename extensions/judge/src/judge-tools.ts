/**
 * The judge's tool surface (agent-analytics §12.2): exactly two read tools
 * (`get_run_facts`, `page_events`) plus the one terminating write tool
 * (`report_verdict`). The judge holds no mutation capability of any kind —
 * the constraint is the design.
 *
 * These specs are SDK-agnostic structural shapes: the pi-SDK adapter in
 * `pi-session.ts` widens them into `ToolDefinition`s, and tests drive the
 * executes directly. No pi import lives here, so the policy (page caps,
 * verdict capture) is testable without a provider.
 *
 * Paging discipline: `page_events` cursors `NormalizedEvent` rows by
 * sequence number over `GET /runs/:id/events?since=<seq>&limit=<n>` — never
 * a held follow stream (FRICTION §1). A judgment has a HARD page cap
 * (`JUDGE_MAX_PAGES`): past it the tool stops serving transcript and tells
 * the model to judge from what it has, so oversized event tails degrade to
 * a lower-confidence verdict instead of unbounded spend. The loop records
 * `pagesRead`/`pageCapHit` in the verdict's provenance so a capped judgment
 * is distinguishable from a full one.
 */

import { Type } from "@sinclair/typebox";
import type { WarrenClient } from "./client.ts";
import { getRun, readEventsSince } from "./client.ts";
import {
	REPORT_VERDICT_TOOL,
	type ReportVerdictArgs,
	validateReportVerdictArgs,
} from "./report-verdict-tool.ts";
import { VerdictValidationError } from "./wire.ts";

/** Text-only tool result, matching what the pi `AgentToolResult` carries. */
export interface JudgeToolResult {
	readonly content: readonly { type: "text"; text: string }[];
	readonly details?: unknown;
	/** pi `AgentToolResult.terminate`: ends the loop after this tool batch. */
	readonly terminate?: boolean;
}

/**
 * SDK-agnostic tool spec. `parameters` is always a TypeBox `TSchema` at
 * runtime; the pi adapter re-tags it (pi pins its own `typebox` package,
 * so the nominal types differ despite identical structure — see FRICTION).
 */
export interface JudgeToolSpec {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly promptGuidelines?: readonly string[];
	execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<JudgeToolResult>;
}

function textResult(text: string, details?: unknown, terminate?: boolean): JudgeToolResult {
	return { content: [{ type: "text", text }], details, terminate };
}

const GET_RUN_FACTS_PARAMETERS = Type.Object({}, { additionalProperties: false });

const PAGE_EVENTS_PARAMETERS = Type.Object(
	{
		since: Type.Integer({
			minimum: 0,
			description:
				"Exclusive sequence cursor: events with seq > since. Start at 0; continue with the last seq you saw.",
		}),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 500,
				description: "Page size, capped server-side. Omit to use the judge's default.",
			}),
		),
	},
	{ additionalProperties: false },
);

const REPORT_VERDICT_PARAMETERS_WITH_LABEL = REPORT_VERDICT_TOOL.parameters;

export interface JudgeToolsDeps {
	readonly client: WarrenClient;
	readonly runId: string;
	/** Default events page size when the model omits `limit`. */
	readonly eventsPageSize: number;
	/** Hard cap on events pages per judgment (JUDGE_MAX_PAGES). */
	readonly maxPages: number;
	/**
	 * Per-judgment USD cap (JUDGE_MAX_COST_USD). Once {@link getAccruedCostUsd}
	 * reaches it, `page_events` stops serving transcript so the attempt lands
	 * on a verdict instead of compounding spend (warren-9a34).
	 */
	readonly maxCostUsd?: number;
	/** Live accrued cost for this judgment: prior attempts + current session. */
	readonly getAccruedCostUsd?: () => number;
}

/**
 * Mutable per-judgment tool state. The loop reads it after the session
 * goes idle: a captured `report_verdict` ends the judgment successfully;
 * `pagesRead`/`pageCapHit` flow into provenance.
 */
export interface JudgeToolsState {
	/** Events pages served this judgment. */
	pagesRead: number;
	/** True once `page_events` refused a page because the cap was hit. */
	pageCapHit: boolean;
	/** True once `page_events` refused a page because accrued cost hit the cap. */
	costCapHit: boolean;
	/** The validated `report_verdict` arguments, once called. */
	reportedVerdict: ReportVerdictArgs | null;
}

export interface JudgeTools {
	readonly tools: readonly JudgeToolSpec[];
	readonly state: JudgeToolsState;
}

/** Raised when the judge calls a tool with semantically invalid input. */
export class JudgeToolError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "JudgeToolError";
	}
}

/**
 * Build the three-tool judge surface for one judgment. Every judgment gets
 * a fresh state so retry attempts never leak a captured verdict or a spent
 * page budget into the next attempt.
 */
export function createJudgeTools(deps: JudgeToolsDeps): JudgeTools {
	const state: JudgeToolsState = {
		pagesRead: 0,
		pageCapHit: false,
		costCapHit: false,
		reportedVerdict: null,
	};

	const getRunFacts: JudgeToolSpec = {
		name: "get_run_facts",
		label: "Get run facts",
		description:
			"Return the judged run's ground truth: outcome, infrastructure failure " +
			"reason, cost, and PR state. Read first, before paging the transcript.",
		parameters: GET_RUN_FACTS_PARAMETERS,
		execute: async () => {
			const detail = await getRun(deps.client, deps.runId);
			return textResult(JSON.stringify(detail, null, 2), detail);
		},
	};

	const pageEvents: JudgeToolSpec = {
		name: "page_events",
		label: "Page events",
		description:
			"Page the run's NormalizedEvent rows by sequence number. Cursor with " +
			"`since` (exclusive); continue from the last seq seen. Transcripts " +
			"routinely exceed one context window, so judge from more than the " +
			"first page — but a hard per-judgment page cap applies, so page the " +
			"regions with signal rather than walking mechanically.",
		parameters: PAGE_EVENTS_PARAMETERS,
		execute: async (_toolCallId, params) => {
			if (typeof params !== "object" || params === null || Array.isArray(params)) {
				throw new JudgeToolError("page_events: params must be an object");
			}
			const since = (params as { since?: unknown }).since;
			if (typeof since !== "number" || !Number.isInteger(since) || since < 0) {
				throw new JudgeToolError("page_events: since must be a non-negative integer cursor");
			}
			const limitRaw = (params as { limit?: unknown }).limit;
			const limit =
				typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw > 0
					? Math.min(limitRaw, 500)
					: deps.eventsPageSize;
			const costCap = deps.maxCostUsd;
			const accrued =
				costCap !== undefined && deps.getAccruedCostUsd !== undefined
					? deps.getAccruedCostUsd()
					: null;
			if (costCap !== undefined && accrued !== null && accrued >= costCap) {
				state.costCapHit = true;
				return textResult(
					JSON.stringify({
						error: "cost_cap_reached",
						message:
							`Accrued cost $${accrued.toFixed(4)} reached the per-judgment ` +
							`cap $${costCap.toFixed(4)}. No further transcript pages will be ` +
							"served: judge from the pages you have, lower confidence to " +
							"match the reduced evidence, and call report_verdict now.",
						pagesRead: state.pagesRead,
						costCapHit: true,
					}),
					{ error: "cost_cap_reached", pagesRead: state.pagesRead },
				);
			}
			if (state.pagesRead >= deps.maxPages) {
				state.pageCapHit = true;
				return textResult(
					JSON.stringify({
						error: "page_cap_reached",
						message:
							`The per-judgment events page cap (${deps.maxPages}) is reached. ` +
							"The transcript is truncated here: judge from the pages you have " +
							"and lower confidence to match the reduced evidence.",
						pagesRead: state.pagesRead,
						pageCapHit: true,
					}),
					{ error: "page_cap_reached", pagesRead: state.pagesRead },
				);
			}
			const events = await readEventsSince(deps.client, deps.runId, { since, limit });
			state.pagesRead += 1;
			if (state.pagesRead >= deps.maxPages) state.pageCapHit = true;
			const lastSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? since) : since;
			return textResult(
				JSON.stringify({
					events,
					count: events.length,
					nextSince: lastSeq,
					hasMore: events.length === limit,
					pagesRead: state.pagesRead,
					pagesRemaining: Math.max(0, deps.maxPages - state.pagesRead),
					pageCapHit: state.pageCapHit,
				}),
				{ count: events.length, nextSince: lastSeq },
			);
		},
	};

	const reportVerdict: JudgeToolSpec = {
		name: REPORT_VERDICT_TOOL.name,
		label: "Report verdict",
		description: REPORT_VERDICT_TOOL.description,
		parameters: REPORT_VERDICT_PARAMETERS_WITH_LABEL,
		promptGuidelines: REPORT_VERDICT_TOOL.promptGuidelines.split("\n"),
		execute: async (_toolCallId, params) => {
			let args: ReportVerdictArgs;
			try {
				args = validateReportVerdictArgs(params);
			} catch (error) {
				if (error instanceof VerdictValidationError) {
					throw new JudgeToolError(error.message);
				}
				throw error;
			}
			if (args.runId !== deps.runId) {
				throw new JudgeToolError(
					`report_verdict: this judgment is for run ${deps.runId}, not ${args.runId}`,
				);
			}
			state.reportedVerdict = args;
			return textResult(
				"Verdict recorded. The judgment is complete; do not call any further tools.",
				{ verdictCaptured: true },
				true,
			);
		},
	};

	return { tools: [getRunFacts, pageEvents, reportVerdict], state };
}
