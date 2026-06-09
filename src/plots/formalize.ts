/**
 * `PlotFormalizer` — Plot conversation-summarize seam for
 * `POST /plots/:id/formalize` (warren-d22e / pl-0344 step 8).
 *
 * Formalize converts a Plot's intent-shaping conversation into a
 * **suggested** Plot intent — a `{goal, non_goals, constraints,
 * success_criteria}` shape the user reviews, edits, and applies via the
 * existing `POST /plots/:id/intent` route. The status transition to
 * `ready` rides on the existing `POST /plots/:id/status` route. This
 * handler is therefore non-mutating: it reads warren's events table for
 * every run bound to the Plot, extracts the agent's
 * marker-formatted intent claims, and returns a JSON suggestion. The
 * Plot itself is untouched, no Plot event is emitted, no run is
 * spawned.
 *
 * Why deterministic extraction, not a dispatched summarize-turn:
 *
 * 1. Conversation turns are async (the reply lands at reap via
 *    `agent_message` capture — see `src/runs/conversation-rewake.ts`). A
 *    synchronous HTTP response that includes an agent-generated summary
 *    would either block on a fresh dispatch or return a half-shape.
 * 2. The intent-shaping agent is
 *    already instructed to name intent fields explicitly via
 *    `**goal**: ...` / `**non_goals**: -` / etc. markers. The contract
 *    is in the system prompt; the parser anchors it.
 * 3. User edits via `POST /plots/:id/intent` are the canonical
 *    finalization step. The suggestion is a starting point, not an
 *    answer; an LLM-generated summary buys no extra accuracy here that
 *    the user wouldn't immediately re-edit.
 *
 * Extraction rules:
 *
 * - The seam scans every `agent_message` event across the Plot's
 *   conversation runs, in `ts` ascending order. Later messages override
 *   earlier ones for the singular `goal` field; list fields
 *   (`non_goals`, `constraints`, `success_criteria`) accumulate
 *   deduplicated.
 * - Markers are case-insensitive and tolerate surrounding bold/heading
 *   syntax: `**goal**: ship X`, `### Goal`, `Goal —`, `# success
 *   criteria` all match. The block that follows the marker (until the
 *   next blank line or recognized marker) is the field body.
 * - List fields parse `- item` / `* item` / `1. item` bullets from the
 *   body. Empty matches yield empty arrays (the suggestion is
 *   "explicitly nothing", not "field absent").
 * - If no agent_message events are found (zero turns), the seam returns
 *   an all-empty suggestion plus `message_count: 0` so the UI can show
 *   "start chatting first" instead of an empty form.
 *
 * The seam's only IO is the warren database; no Plot client open. This
 * mirrors the `defaultPlotIntentEditor` shape (one-method interface +
 * `defaultPlotFormalizer` production impl + `ServerDeps.plotFormalizer`
 * test seam).
 */

import type { Repos } from "../db/repos/index.ts";
import type { EventRow } from "../db/schema.ts";

/** The four Plot intent fields the formalize suggestion covers. */
export interface SuggestedIntent {
	readonly goal: string;
	readonly non_goals: readonly string[];
	readonly constraints: readonly string[];
	readonly success_criteria: readonly string[];
}

export interface FormalizePlotRequest {
	readonly plotId: string;
}

export interface FormalizePlotResult {
	readonly plot_id: string;
	readonly suggested_intent: SuggestedIntent;
	/** Number of `agent_message` events that contributed to the suggestion. */
	readonly source_message_count: number;
}

export interface PlotFormalizer {
	formalize(input: FormalizePlotRequest): Promise<FormalizePlotResult>;
}

export interface DefaultPlotFormalizerDeps {
	readonly repos: Repos;
}

/**
 * Production `PlotFormalizer`. Reads every `agent_message` event on
 * conversation runs bound to the Plot and folds them through
 * `extractSuggestedIntent`. The Plot itself is untouched; the caller
 * (handler) is responsible for validating that the Plot exists.
 */
export function createDefaultPlotFormalizer(deps: DefaultPlotFormalizerDeps): PlotFormalizer {
	return {
		async formalize(input) {
			const runs = await deps.repos.runs.listByPlotId(input.plotId);
			const runIds = runs.map((r) => r.id);
			const events = await deps.repos.events.listByRunIds(runIds);
			const agentMessages = events.filter((e) => e.kind === "agent_message");
			const suggested = extractSuggestedIntent(agentMessages);
			return {
				plot_id: input.plotId,
				suggested_intent: suggested,
				source_message_count: agentMessages.length,
			};
		},
	};
}

const EMPTY_INTENT: SuggestedIntent = {
	goal: "",
	non_goals: [],
	constraints: [],
	success_criteria: [],
};

/**
 * Pure / deterministic extractor. Walks the supplied events in
 * `ts` ascending order, parses field markers out of each
 * `agent_message` payload's `content`, and returns the accumulated
 * suggestion.
 *
 * Exported so unit tests can pin the marker contract directly without
 * staging a fake repos seam.
 */
export function extractSuggestedIntent(events: readonly EventRow[]): SuggestedIntent {
	if (events.length === 0) return EMPTY_INTENT;
	const sorted = [...events].sort((a, b) =>
		a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.burrowEventSeq - b.burrowEventSeq,
	);
	let goal = "";
	const nonGoals = new Set<string>();
	const constraints = new Set<string>();
	const successCriteria = new Set<string>();
	for (const ev of sorted) {
		const content = extractContent(ev.payloadJson);
		if (content === null) continue;
		const parsed = parseMarkers(content);
		if (parsed.goal !== undefined) goal = parsed.goal;
		for (const v of parsed.non_goals) nonGoals.add(v);
		for (const v of parsed.constraints) constraints.add(v);
		for (const v of parsed.success_criteria) successCriteria.add(v);
	}
	return {
		goal,
		non_goals: [...nonGoals],
		constraints: [...constraints],
		success_criteria: [...successCriteria],
	};
}

function extractContent(payload: unknown): string | null {
	if (payload === null || typeof payload !== "object") return null;
	const content = (payload as { content?: unknown }).content;
	return typeof content === "string" ? content : null;
}

interface ParsedBlock {
	goal?: string;
	non_goals: string[];
	constraints: string[];
	success_criteria: string[];
}

const MARKER_FIELDS = {
	goal: "goal",
	non_goals: "non_goals",
	constraints: "constraints",
	success_criteria: "success_criteria",
} as const;
type FieldKey = keyof typeof MARKER_FIELDS;

// Recognise `**goal**:`, `### Goal`, `Goal —`, `# Success Criteria`, etc.
// The leading-bold/heading/plain shapes all reduce to `<word(s)> :|—|-`.
const MARKER_RE =
	/^[\s>#*_-]*\*?\*?(goal|non[\s_-]?goals?|constraints?|success[\s_-]?criteria)\b\*?\*?\s*[:—–-]?\s*(.*)$/i;

function parseMarkers(content: string): ParsedBlock {
	const lines = content.split(/\r?\n/);
	const out: ParsedBlock = { non_goals: [], constraints: [], success_criteria: [] };
	let active: FieldKey | null = null;
	let activeBody: string[] = [];

	const flush = () => {
		if (active === null) return;
		const body = activeBody.join("\n");
		switch (active) {
			case "goal": {
				const collapsed = collapseGoal(body);
				if (collapsed.length > 0) out.goal = collapsed;
				break;
			}
			case "non_goals":
				for (const v of parseList(body)) out.non_goals.push(v);
				break;
			case "constraints":
				for (const v of parseList(body)) out.constraints.push(v);
				break;
			case "success_criteria":
				for (const v of parseList(body)) out.success_criteria.push(v);
				break;
		}
		active = null;
		activeBody = [];
	};

	for (const raw of lines) {
		const match = MARKER_RE.exec(raw);
		if (match) {
			flush();
			active = normalizeFieldKey(match[1] ?? "");
			const inline = (match[2] ?? "").trim();
			if (inline.length > 0) activeBody.push(inline);
			continue;
		}
		if (active !== null) {
			if (raw.trim().length === 0) {
				// Blank line ends a block ONLY for the singular `goal` field;
				// list fields can have blank lines between bullet groups.
				if (active === "goal" && activeBody.length > 0) {
					flush();
				}
				continue;
			}
			activeBody.push(raw);
		}
	}
	flush();
	return out;
}

function normalizeFieldKey(raw: string): FieldKey {
	const k = raw.toLowerCase().replace(/[\s_-]/g, "");
	if (k.startsWith("nongoal")) return "non_goals";
	if (k.startsWith("constraint")) return "constraints";
	if (k.startsWith("successcriter")) return "success_criteria";
	return "goal";
}

function collapseGoal(body: string): string {
	// Collapse the goal block's lines into a single trimmed sentence —
	// `goal` is singular in the Plot intent shape.
	return body
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.join(" ")
		.trim();
}

const BULLET_RE = /^\s*(?:[-*+]|\d+\.)\s+(.+)$/;

function parseList(body: string): string[] {
	const out: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		const m = BULLET_RE.exec(line);
		if (m) {
			const item = (m[1] ?? "").trim();
			if (item.length > 0) out.push(item);
		}
	}
	return out;
}
