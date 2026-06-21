import { describe, expect, test } from "bun:test";
import { buildDispatchPrompt, formatSeedContent } from "./dispatch-prompt.ts";

describe("formatSeedContent", () => {
	test("joins title and body with a blank line", () => {
		expect(formatSeedContent({ id: "warren-1", title: "Fix it", body: "Details here" })).toBe(
			"Fix it\n\nDetails here",
		);
	});

	test("returns title alone when body is absent", () => {
		expect(formatSeedContent({ id: "warren-1", title: "Fix it" })).toBe("Fix it");
	});

	test("returns body alone when title is absent", () => {
		expect(formatSeedContent({ id: "warren-1", body: "Details here" })).toBe("Details here");
	});

	test("trims whitespace and returns empty string when neither present", () => {
		expect(formatSeedContent({ id: "warren-1", title: "  ", body: "" })).toBe("");
		expect(formatSeedContent({ id: "warren-1" })).toBe("");
	});
});

describe("buildDispatchPrompt", () => {
	test("substitutes {seed_id} unchanged when projects match", () => {
		const prompt = buildDispatchPrompt({
			template: "work on sd {seed_id}",
			seed: { id: "warren-92dd", title: "T", body: "B" },
		});
		expect(prompt).toBe("work on sd warren-92dd");
	});

	test("substitutes every {seed_id} occurrence", () => {
		const prompt = buildDispatchPrompt({
			template: "{seed_id} then {seed_id}",
			seed: { id: "warren-1" },
		});
		expect(prompt).toBe("warren-1 then warren-1");
	});

	test("substitutes {seed_body} with the resolved title+body", () => {
		const prompt = buildDispatchPrompt({
			template: "Issue {seed_id}:\n{seed_body}",
			seed: { id: "warren-1", title: "Title", body: "Body text" },
		});
		expect(prompt).toBe("Issue warren-1:\nTitle\n\nBody text");
	});

	test("substitutes both tokens together", () => {
		const prompt = buildDispatchPrompt({
			template: "{seed_id} -> {seed_body}",
			seed: { id: "warren-1", title: "T", body: "B" },
		});
		expect(prompt).toBe("warren-1 -> T\n\nB");
	});

	test("auto-injects seed text on divergent project even when template only has {seed_id}", () => {
		const prompt = buildDispatchPrompt({
			template: "work on sd {seed_id}",
			seed: { id: "warren-92dd", title: "Inline seed", body: "Resolve host-side." },
			crossRepo: true,
		});
		expect(prompt).toContain("work on sd warren-92dd");
		expect(prompt).toContain("warren-92dd");
		expect(prompt).toContain("Inline seed\n\nResolve host-side.");
		expect(prompt).toContain("different repository");
	});

	test("does not auto-inject when template already references {seed_body}", () => {
		const prompt = buildDispatchPrompt({
			template: "{seed_id}: {seed_body}",
			seed: { id: "warren-1", title: "T", body: "B" },
			crossRepo: true,
		});
		expect(prompt).toBe("warren-1: T\n\nB");
		// No duplicate injection block.
		expect(prompt).not.toContain("different repository");
	});

	test("does not auto-inject on cross-repo when there is no seed content", () => {
		const prompt = buildDispatchPrompt({
			template: "work on sd {seed_id}",
			seed: { id: "warren-1" },
			crossRepo: true,
		});
		expect(prompt).toBe("work on sd warren-1");
	});

	test("does not auto-inject when projects match (default)", () => {
		const prompt = buildDispatchPrompt({
			template: "work on sd {seed_id}",
			seed: { id: "warren-1", title: "T", body: "B" },
		});
		expect(prompt).toBe("work on sd warren-1");
		expect(prompt).not.toContain("different repository");
	});
});
