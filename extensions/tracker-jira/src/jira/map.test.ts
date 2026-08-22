import { describe, expect, test } from "bun:test";
import { blockedByKeys, flattenAdf, isDone, pickCloseTransition, toIssueResponse } from "./map.ts";

describe("flattenAdf", () => {
	test("joins paragraphs of an ADF tree into readable text", () => {
		expect(
			flattenAdf({
				type: "doc",
				version: 1,
				content: [
					{ type: "paragraph", content: [{ type: "text", text: "first" }] },
					{ type: "paragraph", content: [{ type: "text", text: "second" }] },
				],
			}),
		).toBe("first\n\nsecond");
	});

	test("keeps the text of a node type it does not know", () => {
		expect(
			flattenAdf({
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{ type: "text", text: "see " },
							{ type: "inlineCard", content: [{ type: "text", text: "WAR-9" }] },
						],
					},
				],
			}),
		).toBe("see WAR-9");
	});

	test("reads a hard break as a newline", () => {
		expect(
			flattenAdf({
				type: "paragraph",
				content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }],
			}),
		).toBe("a\nb");
	});

	test("passes a plain string through, which is what v2 returns", () => {
		expect(flattenAdf("just text")).toBe("just text");
	});

	test("returns undefined for an empty or absent description", () => {
		expect(flattenAdf(null)).toBeUndefined();
		expect(flattenAdf(undefined)).toBeUndefined();
		expect(flattenAdf("")).toBeUndefined();
		expect(flattenAdf({ type: "doc", content: [] })).toBeUndefined();
	});
});

describe("blockedByKeys", () => {
	const links = [
		{
			type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
			inwardIssue: { key: "WAR-2" },
		},
		{
			type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
			outwardIssue: { key: "WAR-7" },
		},
		{
			type: { name: "Relates", inward: "relates to", outward: "relates to" },
			inwardIssue: { key: "WAR-8" },
		},
	];

	test("takes the inward side, which is the blocker", () => {
		expect(blockedByKeys(links, "is blocked by")).toEqual(["WAR-2"]);
	});

	test("ignores the outward side, which is the issue this one blocks", () => {
		expect(blockedByKeys(links, "is blocked by")).not.toContain("WAR-7");
	});

	test("matches the description regardless of case and padding", () => {
		expect(blockedByKeys(links, "  Is Blocked By ")).toEqual(["WAR-2"]);
	});

	test("honours a renamed link type", () => {
		expect(blockedByKeys(links, "relates to")).toEqual(["WAR-8"]);
	});

	test("returns an empty list when the issue carries no links", () => {
		expect(blockedByKeys(undefined, "is blocked by")).toEqual([]);
	});
});

describe("toIssueResponse", () => {
	test("carries the raw Jira status name, not a normalized one", () => {
		const response = toIssueResponse(
			{
				key: "WAR-1",
				fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
			},
			"WAR-1",
			"is blocked by",
		);
		expect(response.status).toBe("In Progress");
	});

	test("leaves out the optional fields Jira did not fill", () => {
		const response = toIssueResponse({ key: "WAR-1", fields: {} }, "WAR-1", "is blocked by");
		expect(response).toEqual({ id: "WAR-1", status: "" });
	});

	test("falls back to the requested key when the payload carries none", () => {
		expect(toIssueResponse({}, "WAR-4", "is blocked by").id).toBe("WAR-4");
	});
});

describe("isDone", () => {
	test("reads the status category, not the status name", () => {
		expect(
			isDone({ fields: { status: { name: "Shipped", statusCategory: { key: "done" } } } }),
		).toBe(true);
		expect(
			isDone({ fields: { status: { name: "Done-ish", statusCategory: { key: "new" } } } }),
		).toBe(false);
		expect(isDone({ fields: { status: { name: "Done" } } })).toBe(false);
	});
});

describe("pickCloseTransition", () => {
	const transitions = [
		{
			id: "11",
			name: "Start",
			to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
		},
		{ id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
		{ id: "41", name: "Reject", to: { name: "Rejected", statusCategory: { key: "done" } } },
	];

	test("takes the first transition landing in the done category", () => {
		expect(pickCloseTransition(transitions, undefined)?.id).toBe("31");
	});

	test("prefers the configured name over the category", () => {
		expect(pickCloseTransition(transitions, "reject")?.id).toBe("41");
	});

	test("returns undefined when the configured name is not on offer", () => {
		expect(pickCloseTransition(transitions, "Archive")).toBeUndefined();
	});

	test("returns undefined when the workflow offers no way out", () => {
		expect(pickCloseTransition([], undefined)).toBeUndefined();
		expect(pickCloseTransition(undefined, undefined)).toBeUndefined();
	});

	test("skips a transition Jira reported without an id", () => {
		expect(
			pickCloseTransition([{ name: "Done", to: { statusCategory: { key: "done" } } }], undefined),
		).toBeUndefined();
	});
});
