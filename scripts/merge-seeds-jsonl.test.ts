import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeJsonl } from "./merge-seeds-jsonl.ts";

const row = (id: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ id, status: "open", ...extra });

const file = (lines: string[]) => `${lines.join("\n")}\n`;

function runDriver(
	ancestor: string,
	ours: string,
	theirs: string,
): { code: number; result: string } {
	const dir = mkdtempSync(join(tmpdir(), "merge-seeds-jsonl-"));
	try {
		const o = join(dir, "o.jsonl");
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(o, ancestor);
		writeFileSync(a, ours);
		writeFileSync(b, theirs);
		const proc = Bun.spawnSync(["bun", "scripts/merge-seeds-jsonl.ts", o, a, b], {
			cwd: join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: proc.exitCode, result: readFileSync(a, "utf8") };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("mergeJsonl", () => {
	test("merges a clean concurrent close of two different issues", () => {
		const ancestor = file([
			row("warren-aaaa", { blockedBy: ["warren-cccc"] }),
			row("warren-bbbb"),
			row("warren-cccc"),
		]);
		const ours = file([
			row("warren-aaaa", { blockedBy: ["warren-cccc"] }),
			row("warren-bbbb", { status: "closed", closedAt: "2026-08-11T01:00:00Z" }),
			row("warren-cccc"),
		]);
		const theirs = file([
			row("warren-aaaa", { blockedBy: [] }),
			row("warren-bbbb"),
			row("warren-cccc", { status: "closed", closedAt: "2026-08-11T02:00:00Z" }),
		]);
		expect(mergeJsonl(ancestor, ours, theirs)).toBe(
			file([
				row("warren-aaaa", { blockedBy: [] }),
				row("warren-bbbb", { status: "closed", closedAt: "2026-08-11T01:00:00Z" }),
				row("warren-cccc", { status: "closed", closedAt: "2026-08-11T02:00:00Z" }),
			]),
		);
	});

	test("applies both sides' blockedBy removals from the same row (pl-d1c9 shape)", () => {
		const ancestor = file([row("warren-umbrella", { blockedBy: ["warren-1111", "warren-2222"] })]);
		// Ours closed warren-1111, theirs closed warren-2222: both removals
		// must survive. The 2-way intersection repair got this right only
		// because both sides removed; the ancestor-relative merge is the
		// principled version.
		const ours = file([row("warren-umbrella", { blockedBy: ["warren-2222"] })]);
		const theirs = file([row("warren-umbrella", { blockedBy: ["warren-1111"] })]);
		expect(mergeJsonl(ancestor, ours, theirs)).toBe(
			file([row("warren-umbrella", { blockedBy: [] })]),
		);
	});

	test("applies one side's blockedBy addition alongside the other's removal", () => {
		const ancestor = file([row("warren-umbrella", { blockedBy: ["warren-1111"] })]);
		const ours = file([row("warren-umbrella", { blockedBy: ["warren-1111", "warren-3333"] })]);
		const theirs = file([row("warren-umbrella", { blockedBy: [] })]);
		expect(mergeJsonl(ancestor, ours, theirs)).toBe(
			file([row("warren-umbrella", { blockedBy: ["warren-3333"] })]),
		);
	});

	test("takes a row added on one side only, in deterministic order", () => {
		const ancestor = file([row("warren-aaaa")]);
		const ours = file([row("warren-aaaa"), row("warren-bbbb", { status: "closed" })]);
		const theirs = file([row("warren-aaaa"), row("warren-cccc")]);
		expect(mergeJsonl(ancestor, ours, theirs)).toBe(
			file([row("warren-aaaa"), row("warren-bbbb", { status: "closed" }), row("warren-cccc")]),
		);
	});

	test("returns undefined on a genuine field conflict changed differently by both sides", () => {
		const ancestor = file([row("warren-aaaa", { priority: 2 })]);
		const ours = file([row("warren-aaaa", { priority: 1 })]);
		const theirs = file([row("warren-aaaa", { priority: 3 })]);
		expect(mergeJsonl(ancestor, ours, theirs)).toBeUndefined();
	});

	test("takes the value when both sides changed a field identically", () => {
		const ancestor = file([row("warren-aaaa", { priority: 2 })]);
		const ours = file([row("warren-aaaa", { priority: 1 })]);
		const theirs = file([row("warren-aaaa", { priority: 1 })]);
		expect(mergeJsonl(ancestor, ours, theirs)).toBe(file([row("warren-aaaa", { priority: 1 })]));
	});

	test("produces byte-identical output when one side is unchanged", () => {
		const ancestor = file([
			row("warren-aaaa"),
			row("warren-bbbb", { title: 'a "quoted" é title' }),
		]);
		const ours = file([
			row("warren-aaaa", { status: "closed", closedAt: "2026-08-11T01:00:00Z" }),
			row("warren-bbbb", { title: 'a "quoted" é title' }),
		]);
		expect(mergeJsonl(ancestor, ours, ancestor)).toBe(ours);
		expect(mergeJsonl(ancestor, ancestor, ours)).toBe(ours);
	});

	test("lets a deletion win when the other side left the row unchanged", () => {
		const ancestor = file([row("warren-aaaa"), row("warren-bbbb")]);
		const ours = file([row("warren-aaaa")]);
		expect(mergeJsonl(ancestor, ours, ancestor)).toBe(file([row("warren-aaaa")]));
	});

	test("conflicts on a delete-versus-edit race", () => {
		const ancestor = file([row("warren-aaaa"), row("warren-bbbb")]);
		const ours = file([row("warren-aaaa"), row("warren-bbbb", { status: "closed" })]);
		const theirs = file([row("warren-aaaa")]);
		expect(mergeJsonl(ancestor, ours, theirs)).toBeUndefined();
	});
});

describe("merge-seeds-jsonl driver CLI", () => {
	test("exits 0 and writes the merge over %A on a clean merge", () => {
		const ancestor = file([row("warren-aaaa", { blockedBy: ["warren-bbbb"] })]);
		const ours = file([row("warren-aaaa", { blockedBy: ["warren-bbbb"], status: "closed" })]);
		const theirs = file([row("warren-aaaa", { blockedBy: [] })]);
		const { code, result } = runDriver(ancestor, ours, theirs);
		expect(code).toBe(0);
		expect(result).toBe(file([row("warren-aaaa", { blockedBy: [], status: "closed" })]));
	});

	test("exits non-zero and leaves %A untouched on a genuine conflict", () => {
		const ancestor = file([row("warren-aaaa", { priority: 2 })]);
		const ours = file([row("warren-aaaa", { priority: 1 })]);
		const theirs = file([row("warren-aaaa", { priority: 3 })]);
		const { code, result } = runDriver(ancestor, ours, theirs);
		expect(code).toBe(1);
		expect(result).toBe(ours);
	});
});
