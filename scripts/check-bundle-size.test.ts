import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Budgets, diff, loadBudgets, measure } from "./check-bundle-size.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUDGETS_PATH = resolve(REPO_ROOT, "scripts/bundle-size-budgets.json");

function makeAssetsDir(files: Array<{ name: string; bytes: Uint8Array }>): string {
	const dir = mkdtempSync(join(tmpdir(), "warren-bundle-"));
	const assets = join(dir, "assets");
	mkdirSync(assets, { recursive: true });
	for (const f of files) writeFileSync(join(assets, f.name), f.bytes);
	return assets;
}

describe("check-bundle-size", () => {
	test("budgets file is well-formed", () => {
		const raw = JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as {
			totals: { raw: Record<string, number>; gzip: Record<string, number> };
			largest: { gzip: Record<string, number> };
		};
		for (const b of ["js", "css"] as const) {
			expect(raw.totals.raw[b]).toBeGreaterThan(0);
			expect(raw.totals.gzip[b]).toBeGreaterThan(0);
			expect(raw.largest.gzip[b]).toBeGreaterThan(0);
			// totals must cover (be >=) the largest single chunk.
			const totalsGzipB = raw.totals.gzip[b] ?? 0;
			const largestGzipB = raw.largest.gzip[b] ?? 0;
			expect(totalsGzipB).toBeGreaterThanOrEqual(largestGzipB);
		}
	});

	test("loadBudgets parses the on-disk budgets file", () => {
		const b = loadBudgets();
		expect(b.totals.raw.js).toBeGreaterThan(0);
		expect(b.totals.gzip.css).toBeGreaterThan(0);
	});

	test("measure aggregates by extension and tracks largest chunk", () => {
		const a = new Uint8Array(1000).fill(65); // "A" — compresses well
		const b = new Uint8Array(500).fill(66);
		const c = new Uint8Array(200).fill(67);
		const assets = makeAssetsDir([
			{ name: "x.js", bytes: a },
			{ name: "y.js", bytes: b },
			{ name: "style.css", bytes: c },
			{ name: "ignore.map", bytes: new Uint8Array([1, 2, 3]) },
		]);
		const m = measure(assets);
		expect(m.totals.raw.js).toBe(1500);
		expect(m.totals.raw.css).toBe(200);
		expect(m.files).toHaveLength(3);
		// largest.gzip.js should be the gzip size of x.js (the bigger file).
		const xJs = m.files.find((f) => f.name === "x.js");
		expect(xJs).toBeDefined();
		if (xJs) expect(m.largest.gzip.js).toBe(xJs.gzip);
	});

	test("measure returns zeros when assets dir is missing", () => {
		const m = measure(join(tmpdir(), "warren-bundle-does-not-exist-xyz"));
		expect(m.totals.raw.js).toBe(0);
		expect(m.files).toEqual([]);
	});

	test("diff flags totals + largest overruns and stays quiet at the ceiling", () => {
		const budgets: Budgets = {
			totals: { raw: { js: 1000, css: 1000 }, gzip: { js: 100, css: 100 } },
			largest: { gzip: { js: 80, css: 80 } },
		};
		const overrun = {
			totals: { raw: { js: 1001, css: 999 }, gzip: { js: 100, css: 100 } },
			largest: { gzip: { js: 81, css: 80 } },
			files: [],
		};
		const failures = diff(overrun, budgets);
		const metrics = failures.map((f) => `${f.metric}.${f.bucket}`).sort();
		expect(metrics).toEqual(["largest.gzip.js", "totals.raw.js"]);

		const atCeiling = {
			totals: { raw: { js: 1000, css: 1000 }, gzip: { js: 100, css: 100 } },
			largest: { gzip: { js: 80, css: 80 } },
			files: [],
		};
		expect(diff(atCeiling, budgets)).toEqual([]);
	});

	test("current dist passes the guard when present", () => {
		const distAssets = resolve(REPO_ROOT, "src/ui/dist/assets");
		const m = measure(distAssets);
		if (m.files.length === 0) return; // dist not built in this environment — skip
		const failures = diff(m, loadBudgets());
		expect(failures).toEqual([]);
	});
});
