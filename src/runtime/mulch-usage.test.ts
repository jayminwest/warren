import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	collectMulchUsageEvent,
	MULCH_USAGE_EVENT,
	MULCH_USAGE_REL,
	summarizeMulchUsage,
} from "./mulch-usage.ts";

const LINES = [
	{
		ts: "2026-09-01T00:00:02.000Z",
		session: "s1",
		tool: "Read",
		files: ["a.ts"],
		ids: ["mx-a", "mx-b"],
	},
	{ ts: "2026-09-01T00:00:01.000Z", session: "s1", tool: "Edit", files: ["b.ts"], ids: ["mx-a"] },
	{ ts: "2026-09-01T00:00:03.000Z", session: null, tool: "Read", files: ["c.ts"], ids: ["mx-c"] },
]
	.map((l) => JSON.stringify(l))
	.join("\n");

describe("summarizeMulchUsage", () => {
	test("counts injections, per-record totals, sessions, tools, and the time span", () => {
		const s = summarizeMulchUsage(`${LINES}\n\n`);
		expect(s.injections).toBe(3);
		expect(s.uniqueRecords).toBe(3);
		expect(s.recordInjections).toBe(4);
		expect(s.sessions).toBe(1);
		expect(s.tools).toEqual({ Read: 2, Edit: 1 });
		expect(s.records).toEqual([
			{ id: "mx-a", count: 2 },
			{ id: "mx-b", count: 1 },
			{ id: "mx-c", count: 1 },
		]);
		expect(s.firstTs).toBe("2026-09-01T00:00:01.000Z");
		expect(s.lastTs).toBe("2026-09-01T00:00:03.000Z");
		expect(s.malformedLines).toBe(0);
	});

	test("skips and counts malformed lines instead of throwing", () => {
		const s = summarizeMulchUsage(`not json\n[1]\n{"ids":"mx-a"}\n${LINES}`);
		expect(s.malformedLines).toBe(3);
		expect(s.injections).toBe(3);
	});

	test("an empty body summarizes to zeros", () => {
		const s = summarizeMulchUsage("");
		expect(s).toMatchObject({ injections: 0, uniqueRecords: 0, firstTs: null, lastTs: null });
	});
});

describe("collectMulchUsageEvent", () => {
	test("reads the workspace usage log and emits one mulch.usage event", async () => {
		const seen: string[] = [];
		const ev = await collectMulchUsageEvent("/ws", async (p) => {
			seen.push(p);
			return LINES;
		});
		expect(seen).toEqual([join("/ws", MULCH_USAGE_REL)]);
		expect(ev?.kind).toBe(MULCH_USAGE_EVENT);
		expect((ev?.payload as { injections: number } | undefined)?.injections).toBe(3);
	});

	test("fails open: absent, empty, or unreadable logs yield no event", async () => {
		expect(await collectMulchUsageEvent("/ws", async () => null)).toBeNull();
		expect(await collectMulchUsageEvent("/ws", async () => "  \n")).toBeNull();
		expect(
			await collectMulchUsageEvent("/ws", async () => {
				throw new Error("EACCES");
			}),
		).toBeNull();
	});
});
