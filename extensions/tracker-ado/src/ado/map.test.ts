import { describe, expect, test } from "bun:test";
import { AGILE_STATES as AGILE } from "../fake-ado.ts";
import {
	blockedByIds,
	describeWorkItem,
	htmlToText,
	issueStatus,
	isTerminal,
	parseWorkItemId,
	pickCloseState,
	toIssueResponse,
	workItemIdFromUrl,
} from "./map.ts";
import type { AdoRelation, AdoWorkItem, AdoWorkItemFields } from "./types.ts";

const LINK = "System.LinkTypes.Dependency-Reverse";

/** A work item as the client hands it on: id and state present, the rest as given. */
function workItem(
	fields: Partial<AdoWorkItemFields> = {},
	relations?: readonly AdoRelation[],
): AdoWorkItem {
	return {
		id: 7,
		rev: 1,
		fields: { "System.State": "Active", ...fields },
		...(relations !== undefined ? { relations } : {}),
	};
}

describe("parseWorkItemId", () => {
	test("accepts a decimal work item number", () => {
		expect(parseWorkItemId("96379")).toBe(96379);
	});

	test("rejects anything that names no work item", () => {
		for (const raw of ["", "0", "-1", "abc", "1.5", "007", "1e3", " 12"]) {
			expect(parseWorkItemId(raw), raw).toBeUndefined();
		}
	});
});

describe("htmlToText", () => {
	test("turns block ends into newlines and drops every other tag", () => {
		expect(htmlToText("<div>One</div><div>Two <b>bold</b></div>")).toBe("One\nTwo bold");
	});

	test("honors line breaks and collapses runs of blank lines", () => {
		expect(htmlToText("<p>A</p><p><br></p><p><br/></p><p>B</p>")).toBe("A\n\nB");
	});

	test("reads a line break that carries attributes", () => {
		expect(htmlToText('A<br class="x">B<br data-x="1"/>C')).toBe("A\nB\nC");
	});

	test("keeps a quoted > inside an attribute from ending the tag early", () => {
		expect(htmlToText('<a href="?a>b" title=\'>\'>link</a> <img alt="x>y">after')).toBe(
			"link after",
		);
	});

	test("trims the padding azure devops adds between closing tags when it saves", () => {
		// The shape the service stored for `<ul><li>one</li><li>two</li></ul><p>Para</p>`.
		expect(htmlToText("<ul><li>one </li><li>two </li> </ul><p>Para </p>")).toBe("one\ntwo\nPara");
	});

	test("decodes the entities the editor emits", () => {
		expect(htmlToText("a&nbsp;&amp;&nbsp;b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;")).toBe(
			"a & b <c> \"d\" 'e' A",
		);
	});

	test("leaves an unknown entity alone rather than guessing", () => {
		expect(htmlToText("&bogus; &#xzz;")).toBe("&bogus; &#xzz;");
	});

	test("answers undefined for a missing or empty field", () => {
		expect(htmlToText(undefined)).toBeUndefined();
		expect(htmlToText(null)).toBeUndefined();
		expect(htmlToText("<div><br></div>")).toBeUndefined();
	});
});

describe("describeWorkItem", () => {
	test("labels the sections the process template splits the narrative across", () => {
		const text = describeWorkItem(
			workItem({
				"System.Description": "<div>Story</div>",
				"Microsoft.VSTS.TCM.ReproSteps": "<div>Steps</div>",
				"Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>One</li><li>Two</li></ul>",
			}),
		);
		expect(text).toBe("Story\n\nRepro steps:\nSteps\n\nAcceptance criteria:\nOne\nTwo");
	});

	test("carries a bug's repro steps when it has no description", () => {
		expect(describeWorkItem(workItem({ "Microsoft.VSTS.TCM.ReproSteps": "Crash" }))).toBe(
			"Repro steps:\nCrash",
		);
	});

	test("answers undefined when every field is empty", () => {
		expect(describeWorkItem(workItem({ "System.Description": null }))).toBeUndefined();
		expect(describeWorkItem(workItem())).toBeUndefined();
	});
});

describe("workItemIdFromUrl", () => {
	test("reads the id off the end of a work item url", () => {
		expect(workItemIdFromUrl("https://dev.azure.com/acme/_apis/wit/workItems/42")).toBe(42);
		expect(workItemIdFromUrl("https://dev.azure.com/acme/_apis/wit/workitems/42/")).toBe(42);
	});

	test("answers undefined for anything else", () => {
		expect(workItemIdFromUrl(undefined)).toBeUndefined();
		expect(workItemIdFromUrl("https://dev.azure.com/acme/_apis/wit/workItems/abc")).toBeUndefined();
		expect(
			workItemIdFromUrl("https://dev.azure.com/acme/_apis/git/repositories/1"),
		).toBeUndefined();
	});
});

describe("blockedByIds", () => {
	test("reads the predecessor side of a dependency link", () => {
		const ids = blockedByIds(
			[
				{ rel: LINK, url: "https://dev.azure.com/acme/_apis/wit/workItems/1" },
				{ rel: "System.LinkTypes.Dependency-Forward", url: "https://x/_apis/wit/workItems/2" },
				{ rel: "System.LinkTypes.Related", url: "https://x/_apis/wit/workItems/3" },
				{ rel: LINK },
				{ rel: LINK, url: "https://dev.azure.com/acme/_apis/wit/workItems/4" },
			],
			LINK,
		);
		expect(ids).toEqual(["1", "4"]);
	});

	test("matches the configured link type case-insensitively", () => {
		expect(
			blockedByIds([{ rel: LINK.toUpperCase(), url: "https://x/_apis/wit/workItems/9" }], LINK),
		).toEqual(["9"]);
	});

	test("answers an empty list without relations", () => {
		expect(blockedByIds(undefined, LINK)).toEqual([]);
	});
});

describe("issueStatus", () => {
	test("folds every state category onto warren's three-state vocabulary", () => {
		expect(issueStatus(workItem({ "System.State": "New" }), AGILE)).toBe("open");
		expect(issueStatus(workItem({ "System.State": "Active" }), AGILE)).toBe("other");
		expect(issueStatus(workItem({ "System.State": "Resolved" }), AGILE)).toBe("other");
		expect(issueStatus(workItem({ "System.State": "Closed" }), AGILE)).toBe("closed");
		expect(issueStatus(workItem({ "System.State": "Removed" }), AGILE)).toBe("closed");
	});

	test("goes by the category, not the name, so a Scrum 'Done' is closed too", () => {
		const scrum = [
			{ name: "New", category: "Proposed" },
			{ name: "Approved", category: "Proposed" },
			{ name: "Committed", category: "InProgress" },
			{ name: "Done", category: "Completed" },
		];
		expect(issueStatus(workItem({ "System.State": "Done" }), scrum)).toBe("closed");
		expect(issueStatus(workItem({ "System.State": "Approved" }), scrum)).toBe("open");
		expect(issueStatus(workItem({ "System.State": "Committed" }), scrum)).toBe("other");
	});

	test("matches the state name case-insensitively", () => {
		expect(issueStatus(workItem({ "System.State": "closed" }), AGILE)).toBe("closed");
		expect(issueStatus(workItem({ "System.State": " NEW " }), AGILE)).toBe("open");
	});

	test("answers other for a state the process does not define, never open", () => {
		expect(issueStatus(workItem({ "System.State": "Mystery" }), AGILE)).toBe("other");
		expect(issueStatus(workItem({ "System.State": "" }), AGILE)).toBe("other");
		expect(issueStatus(workItem({ "System.State": "New" }), [])).toBe("other");
	});
});

describe("isTerminal", () => {
	test("is true in the Completed and Removed categories", () => {
		expect(isTerminal(workItem({ "System.State": "Closed" }), AGILE)).toBe(true);
		expect(isTerminal(workItem({ "System.State": "removed" }), AGILE)).toBe(true);
	});

	test("is false elsewhere, and for a state the process does not define", () => {
		expect(isTerminal(workItem({ "System.State": "Resolved" }), AGILE)).toBe(false);
		expect(isTerminal(workItem({ "System.State": "Mystery" }), AGILE)).toBe(false);
		expect(isTerminal(workItem({ "System.State": "" }), AGILE)).toBe(false);
	});
});

describe("pickCloseState", () => {
	test("takes the first Completed-category state when none is configured", () => {
		expect(pickCloseState(AGILE, undefined)).toBe("Closed");
	});

	test("prefers the configured name, matched case-insensitively, in the process's spelling", () => {
		expect(pickCloseState(AGILE, "closed")).toBe("Closed");
		expect(pickCloseState(AGILE, "removed")).toBe("Removed");
	});

	test("answers undefined when the configured name is not a state of this type", () => {
		expect(pickCloseState(AGILE, "Done")).toBeUndefined();
	});

	test("answers undefined when the configured state is not terminal, so close would not stick", () => {
		expect(pickCloseState(AGILE, "Resolved")).toBeUndefined();
		expect(pickCloseState(AGILE, "Active")).toBeUndefined();
	});

	test("answers undefined when the process has no Completed-category state", () => {
		expect(pickCloseState([{ name: "New", category: "Proposed" }], undefined)).toBeUndefined();
		expect(pickCloseState([], undefined)).toBeUndefined();
	});
});

describe("toIssueResponse", () => {
	test("maps every field and omits the empty ones", () => {
		expect(
			toIssueResponse(
				workItem({ "System.Title": "Title", "System.Description": "<p>Body</p>" }, [
					{ rel: LINK, url: "https://x/_apis/wit/workItems/3" },
				]),
				AGILE,
				LINK,
			),
		).toEqual({
			id: "7",
			status: "other",
			title: "Title",
			description: "Body",
			blockedBy: ["3"],
		});
	});

	test("omits title, description and blockers when the payload carries none", () => {
		expect(toIssueResponse(workItem({ "System.Title": "" }), AGILE, LINK)).toEqual({
			id: "7",
			status: "other",
		});
	});

	test("reports the state on warren's vocabulary, not the process's spelling", () => {
		expect(toIssueResponse(workItem({ "System.State": "New" }), AGILE, LINK).status).toBe("open");
		expect(toIssueResponse(workItem({ "System.State": "Closed" }), AGILE, LINK).status).toBe(
			"closed",
		);
	});
});
