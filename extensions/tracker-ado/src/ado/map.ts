/**
 * Azure DevOps payloads to warren-tracker/v1 shapes. Pure, and defensive
 * about every field: these values crossed an HTTP boundary.
 *
 * The one rule worth stating twice is the status rule. `status` on the
 * wire is warren's `open | closed | other`, never the raw `System.State`.
 * A process names its states however it likes ("New", "Active", "Done",
 * "Closed"), and warren's bridge folds every spelling it does not know
 * to `other`, so the fold has to happen here, where the state's category
 * is known: `Proposed` is open, `Completed` and `Removed` are closed, and
 * `InProgress` and `Resolved` are neither.
 */

import type { IssueStatus, RemoteIssueResponse } from "../protocol.ts";
import {
	ADO_COMPLETED_CATEGORY,
	ADO_PROPOSED_CATEGORY,
	ADO_REMOVED_CATEGORY,
	type AdoRelation,
	type AdoWorkItem,
	type AdoWorkItemTypeState,
} from "./types.ts";

/**
 * A work item id on the wire is its decimal number. Anything else names
 * no work item that could exist, so the caller answers not-found without
 * asking Azure DevOps, which would answer 400 for it.
 */
export function parseWorkItemId(raw: string): number | undefined {
	if (!/^[1-9]\d*$/.test(raw)) return undefined;
	const id = Number(raw);
	return Number.isSafeInteger(id) ? id : undefined;
}

const BLOCK_END = /<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)\s*>|<br\b[^>]*>/gi;
/** A tag, with a `>` inside a quoted attribute value still part of it. */
const TAG = /<(?:[^'">]|"[^"]*"|'[^']*')*>/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/**
 * Flatten the HTML Azure DevOps stores in its rich-text fields to plain
 * text. Block ends become newlines, every other tag disappears, and the
 * entities the editor emits are decoded. Azure DevOps pads the markup it
 * saves with spaces between closing tags (`</li> </ul>`), so each line is
 * trimmed on both ends. Runs of blank lines collapse to one, which keeps
 * a description readable in a prompt without pretending to be a renderer.
 */
export function htmlToText(html: unknown): string | undefined {
	if (typeof html !== "string") return undefined;
	const text = html
		.replace(BLOCK_END, "\n")
		.replace(TAG, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

function decodeEntity(match: string, body: string): string {
	const lower = body.toLowerCase();
	if (lower.startsWith("#x")) return codePoint(Number.parseInt(lower.slice(2), 16), match);
	if (lower.startsWith("#")) return codePoint(Number.parseInt(lower.slice(1), 10), match);
	return NAMED_ENTITIES[lower] ?? match;
}

function codePoint(value: number, fallback: string): string {
	return Number.isInteger(value) && value > 0 && value <= 0x10ffff
		? String.fromCodePoint(value)
		: fallback;
}

/**
 * The narrative an agent needs, assembled from the rich-text fields the
 * process template splits it across. A story carries a description and
 * acceptance criteria; an Agile bug carries repro steps instead of a
 * description. Each section present is labeled so the agent can tell the
 * criteria apart from the story.
 */
export function describeWorkItem(item: AdoWorkItem): string | undefined {
	const fields = item.fields;
	const sections: string[] = [];
	const description = htmlToText(fields["System.Description"]);
	if (description !== undefined) sections.push(description);
	const repro = htmlToText(fields["Microsoft.VSTS.TCM.ReproSteps"]);
	if (repro !== undefined) sections.push(`Repro steps:\n${repro}`);
	const criteria = htmlToText(fields["Microsoft.VSTS.Common.AcceptanceCriteria"]);
	if (criteria !== undefined) sections.push(`Acceptance criteria:\n${criteria}`);
	return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/** The numeric id at the end of a work item REST url. */
export function workItemIdFromUrl(url: string | undefined): number | undefined {
	if (url === undefined) return undefined;
	const match = /\/workItems\/(\d+)\/?$/i.exec(url);
	return match?.[1] === undefined ? undefined : parseWorkItemId(match[1]);
}

/**
 * The ids of the work items that block this one. Azure DevOps models the
 * relationship as a dependency link, and the REVERSE side of it (the
 * predecessor) is the blocker. The link type is a process setting an
 * admin can change, which is why it is configurable.
 */
export function blockedByIds(
	relations: readonly AdoRelation[] | undefined,
	linkType: string,
): string[] {
	if (relations === undefined) return [];
	const wanted = linkType.trim().toLowerCase();
	const ids: string[] = [];
	for (const relation of relations) {
		if (relation.rel?.trim().toLowerCase() !== wanted) continue;
		const id = workItemIdFromUrl(relation.url);
		if (id !== undefined) ids.push(String(id));
	}
	return ids;
}

/** The raw state name, in the process's own spelling. */
function stateName(item: AdoWorkItem): string {
	return item.fields["System.State"];
}

/** The category the process files the work item's current state under. */
function stateCategory(
	item: AdoWorkItem,
	states: readonly AdoWorkItemTypeState[],
): string | undefined {
	const current = stateName(item).trim().toLowerCase();
	return states.find((s) => s.name?.trim().toLowerCase() === current)?.category;
}

/**
 * The work item's state on warren's three-state vocabulary. `Proposed`
 * is the only category warren may claim from. A state the process does
 * not define at all is `other` as well: it cannot be shown closed, and
 * claiming it would be a guess.
 */
export function issueStatus(
	item: AdoWorkItem,
	states: readonly AdoWorkItemTypeState[],
): IssueStatus {
	const category = stateCategory(item, states);
	if (isTerminalCategory(category)) return "closed";
	if (category === ADO_PROPOSED_CATEGORY) return "open";
	return "other";
}

/**
 * True when the process considers the state terminal, whatever it is
 * called. Both `Completed` and `Removed` count: a removed work item is
 * off the backlog, and moving it back just to close it would undo a
 * decision someone made on the board.
 */
export function isTerminal(item: AdoWorkItem, states: readonly AdoWorkItemTypeState[]): boolean {
	return isTerminalCategory(stateCategory(item, states));
}

function isTerminalCategory(category: string | undefined): boolean {
	return category === ADO_COMPLETED_CATEGORY || category === ADO_REMOVED_CATEGORY;
}

export function toIssueResponse(
	item: AdoWorkItem,
	states: readonly AdoWorkItemTypeState[],
	linkType: string,
): RemoteIssueResponse {
	const title = item.fields["System.Title"] ?? undefined;
	const description = describeWorkItem(item);
	const blockedBy = blockedByIds(item.relations, linkType);
	return {
		id: String(item.id),
		status: issueStatus(item, states),
		...(typeof title === "string" && title.length > 0 ? { title } : {}),
		...(description !== undefined ? { description } : {}),
		...(blockedBy.length > 0 ? { blockedBy } : {}),
	};
}

/**
 * The state that closes the work item. A configured name wins and is
 * matched case-insensitively against the states the process defines,
 * because an operator who named one means that one. Otherwise the first
 * `Completed`-category state is the answer, which is how Azure DevOps
 * itself defines finished.
 *
 * Whichever way it was chosen, the state must be one {@link isTerminal}
 * accepts. A configured name in another category (`Resolved` on the
 * Agile template, say) would make close a state change that a second
 * close repeats, because the item never reads as closed afterwards.
 *
 * Returns undefined when the process offers no such state. That is a
 * real configuration answer, not a transient failure, so the caller must
 * not retry it.
 */
export function pickCloseState(
	states: readonly AdoWorkItemTypeState[],
	configuredName: string | undefined,
): string | undefined {
	const named = states.filter(
		(s): s is AdoWorkItemTypeState & { name: string } =>
			typeof s.name === "string" && s.name.length > 0,
	);
	if (configuredName !== undefined) {
		const wanted = configuredName.trim().toLowerCase();
		const match = named.find((s) => s.name.trim().toLowerCase() === wanted);
		return match !== undefined && isTerminalCategory(match.category) ? match.name : undefined;
	}
	return named.find((s) => s.category === ADO_COMPLETED_CATEGORY)?.name;
}
