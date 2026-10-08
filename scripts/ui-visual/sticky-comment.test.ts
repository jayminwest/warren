import { describe, expect, test } from "bun:test";

import { FakeGhApi } from "./fake-gh-api.ts";
import {
	findStickyComment,
	pickStickyComment,
	stickyMarker,
	updateStickyCommentIfPresent,
	upsertStickyComment,
} from "./sticky-comment.ts";

const MARKER = stickyMarker("ui-visual");
const TARGET = { repo: "o/r", pr: 7, marker: MARKER };

describe("stickyMarker", () => {
	test("builds a hidden HTML comment from a kebab-case name", () => {
		expect(stickyMarker("design-review")).toBe("<!-- design-review -->");
		expect(() => stickyMarker("x -->")).toThrow();
	});
});

describe("pickStickyComment", () => {
	test("takes the first bot comment that starts with the marker", () => {
		const comments = [
			{ id: 1, body: `quoting ${MARKER}`, user: { type: "Bot" } },
			{ id: 2, body: `${MARKER}\nhuman copy`, user: { type: "User" } },
			{ id: 3, body: "<!-- design-review -->\nother topic", user: { type: "Bot" } },
			{ id: 4, body: `${MARKER}\nours`, user: { type: "Bot" } },
			{ id: 5, body: `${MARKER}\nlater`, user: { type: "Bot" } },
		];
		expect(pickStickyComment(comments, MARKER)).toEqual({ id: 4, body: `${MARKER}\nours` });
		expect(pickStickyComment(comments, "<!-- nope -->")).toBeNull();
	});
});

describe("upsertStickyComment", () => {
	test("creates once, then edits the same comment in place", async () => {
		const api = new FakeGhApi();
		const first = await upsertStickyComment(api, TARGET, `${MARKER}\none`);
		expect(first.action).toBe("created");
		const second = await upsertStickyComment(api, TARGET, `${MARKER}\ntwo`);
		expect(second).toEqual({ action: "updated", id: first.action === "created" ? first.id : -1 });
		expect(await upsertStickyComment(api, TARGET, `${MARKER}\ntwo`)).toMatchObject({
			action: "unchanged",
		});
		expect(api.comments.get(7)?.map((c) => c.body)).toEqual([`${MARKER}\ntwo`]);
	});

	test("leaves another marker's comment alone", async () => {
		const api = new FakeGhApi();
		api.addComment(7, "<!-- design-review -->\nfindings");
		await upsertStickyComment(api, TARGET, `${MARKER}\nours`);
		expect(api.comments.get(7)?.map((c) => c.body)).toEqual([
			"<!-- design-review -->\nfindings",
			`${MARKER}\nours`,
		]);
	});

	test("refuses a body without the marker", async () => {
		await expect(upsertStickyComment(new FakeGhApi(), TARGET, "no marker")).rejects.toThrow(
			/must start/,
		);
	});
});

describe("updateStickyCommentIfPresent", () => {
	test("never creates a comment", async () => {
		const api = new FakeGhApi();
		expect(await updateStickyCommentIfPresent(api, TARGET, `${MARKER}\nresolved`)).toEqual({
			action: "absent",
		});
		const existing = api.addComment(7, `${MARKER}\nfailed`);
		expect(await findStickyComment(api, TARGET)).toEqual({
			id: existing.id,
			body: `${MARKER}\nfailed`,
		});
		await updateStickyCommentIfPresent(api, TARGET, `${MARKER}\nresolved`);
		expect(existing.body).toBe(`${MARKER}\nresolved`);
	});
});
