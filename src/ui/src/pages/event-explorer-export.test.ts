import { describe, expect, test } from "bun:test";
import { buildFilter, collectExportLines, EXPORT_MAX_ROWS } from "./event-explorer-export.ts";

describe("buildFilter", () => {
	test("returns an empty filter for the default strip state", () => {
		expect(
			buildFilter({ stream: "all", kind: "", runId: "", projectId: "", rangeId: "24h" }),
		).toEqual({});
	});

	test("maps every populated field onto the API filter", () => {
		expect(
			buildFilter({
				stream: "stdout",
				kind: "toolcall",
				runId: "run_x",
				projectId: "p1",
				rangeId: "1h",
			}),
		).toEqual({ stream: "stdout", kind: "toolcall", runId: "run_x", projectId: "p1" });
	});
});

describe("collectExportLines", () => {
	test("stops when a short page ends the filtered set", async () => {
		let calls = 0;
		const fetchPage = async (offset: number) => {
			calls += 1;
			if (offset === 0) return { events: [{ id: 1 }, { id: 2 }], total: 2 };
			throw new Error("past the end");
		};
		const out = await collectExportLines(fetchPage);
		expect(out.lines).toEqual(['{"id":1}', '{"id":2}']);
		expect(out.capped).toBe(false);
		expect(calls).toBe(1);
	});

	test("walks pages until the total is covered", async () => {
		const fetchPage = async (offset: number) => {
			const events = Array.from({ length: 2 }, (_, i) => ({ id: offset + i }));
			return { events, total: 4 };
		};
		const out = await collectExportLines(fetchPage);
		expect(out.lines).toHaveLength(4);
		expect(out.capped).toBe(false);
	});

	test("caps the export at the row budget", async () => {
		const fetchPage = async (offset: number) => {
			const events = Array.from({ length: 500 }, (_, i) => ({ id: offset + i }));
			return { events, total: 100_000 };
		};
		const out = await collectExportLines(fetchPage);
		expect(out.lines).toHaveLength(EXPORT_MAX_ROWS);
		expect(out.capped).toBe(true);
	});

	test("handles an empty result set", async () => {
		const out = await collectExportLines(async () => ({ events: [], total: 0 }));
		expect(out.lines).toEqual([]);
		expect(out.capped).toBe(false);
	});
});
