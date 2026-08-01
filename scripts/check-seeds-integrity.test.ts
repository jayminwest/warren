import { describe, expect, test } from "bun:test";
import { contradicts, scanText } from "./check-seeds-integrity.ts";

const FILE = ".seeds/issues.jsonl";

function row(id: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ id, title: `Issue ${id}`, status: "open", type: "task", ...extra });
}

describe("check-seeds-integrity scanText", () => {
	test("passes a clean file with unique ids", () => {
		const text = [row("warren-0001"), row("warren-0002", { status: "closed", closedAt: "x" })].join(
			"\n",
		);
		expect(scanText(FILE, text)).toEqual([]);
	});

	test("ignores blank lines", () => {
		expect(scanText(FILE, `\n${row("warren-0001")}\n\n`)).toEqual([]);
	});

	test("flags a duplicate id with file:line", () => {
		const text = [row("warren-0001"), row("warren-0002"), row("warren-0001")].join("\n");
		const violations = scanText(FILE, text);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.kind).toBe("duplicate-id");
		expect(violations[0]?.line).toBe(3);
		expect(violations[0]?.message).toContain("warren-0001");
		expect(violations[0]?.message).toContain("line 1");
	});

	test("flags an open+closed contradiction for the same id", () => {
		const text = [
			row("warren-0001"),
			row("warren-0001", { status: "closed", closedAt: "2026-07-31T00:00:00.000Z" }),
		].join("\n");
		const violations = scanText(FILE, text);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.kind).toBe("contradiction");
		expect(violations[0]?.line).toBe(2);
		expect(violations[0]?.message).toContain("contradicts line 1");
	});

	test("flags a truncated or malformed row", () => {
		const text = [row("warren-0001"), '{"id":"warren-0002","status":"op'].join("\n");
		const violations = scanText(FILE, text);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.kind).toBe("invalid-json");
		expect(violations[0]?.line).toBe(2);
	});

	test("flags a row without a string id", () => {
		const violations = scanText(FILE, JSON.stringify({ title: "no id" }));
		expect(violations[0]?.kind).toBe("invalid-json");
	});

	test("flags every extra row when an id appears three times", () => {
		const text = [row("warren-0001"), row("warren-0001"), row("warren-0001")].join("\n");
		const violations = scanText(FILE, text);
		expect(violations).toHaveLength(2);
		expect(violations.map((v) => v.line)).toEqual([2, 3]);
	});
});

describe("check-seeds-integrity contradicts", () => {
	const base = { line: 1, id: "warren-0001", status: "open", closed: false };

	test("treats identical outcome rows as non-contradictory", () => {
		expect(contradicts(base, { ...base, line: 2 })).toBe(false);
	});

	test("treats a status change as contradictory", () => {
		expect(contradicts(base, { ...base, line: 2, status: "closed" })).toBe(true);
	});

	test("treats a closedAt-only difference as contradictory", () => {
		expect(contradicts(base, { ...base, line: 2, closed: true })).toBe(true);
	});
});
