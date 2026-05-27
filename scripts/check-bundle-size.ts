#!/usr/bin/env bun
/**
 * Bundle-size guard for the Vite UI build (warren-5abc, plan pl-7b06 step 13).
 *
 * Scans `src/ui/dist/assets/` for `.js` and `.css` files (Vite hashes
 * filenames, so we aggregate by extension rather than by name) and
 * enforces a ratchet recorded in `scripts/bundle-size-budgets.json`:
 *
 *   - `totals.raw.{js,css}` — total uncompressed bytes per extension.
 *   - `totals.gzip.{js,css}` — total gzipped bytes per extension.
 *   - `largest.gzip.{js,css}` — gzipped size of the single largest
 *     chunk per extension (catches a single chunk ballooning even
 *     when the total stays flat).
 *
 * The ratchet only goes DOWN. To shrink budgets, refactor / code-split
 * then lower the numbers. To grow past a budget: refactor first; do NOT
 * raise the number — that would defeat the guard.
 *
 * Usage:
 *   bun run scripts/check-bundle-size.ts             # measure existing dist/
 *   bun run scripts/check-bundle-size.ts --build     # build:ui first, then measure
 *
 * If `src/ui/dist/` is missing the script exits non-zero with a hint
 * unless `--build` (or `WARREN_BUNDLE_SIZE_BUILD=1`) is set.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUDGETS_PATH = resolve(REPO_ROOT, "scripts/bundle-size-budgets.json");
const DIST_DIR = resolve(REPO_ROOT, "src/ui/dist");
const ASSETS_DIR = resolve(DIST_DIR, "assets");

type Bucket = "js" | "css";
const BUCKETS: readonly Bucket[] = ["js", "css"] as const;

export type Budgets = {
	totals: { raw: Record<Bucket, number>; gzip: Record<Bucket, number> };
	largest: { gzip: Record<Bucket, number> };
};

export type Measurement = {
	totals: { raw: Record<Bucket, number>; gzip: Record<Bucket, number> };
	largest: { gzip: Record<Bucket, number> };
	files: Array<{ name: string; bucket: Bucket; raw: number; gzip: number }>;
};

export type Failure = { metric: string; bucket: Bucket; actual: number; budget: number };

function assertPositiveInt(value: unknown, label: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value <= 0 ||
		!Number.isInteger(value)
	) {
		throw new Error(`${BUDGETS_PATH}: ${label} must be a positive integer`);
	}
	return value;
}

export function loadBudgets(): Budgets {
	const raw = JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as Record<string, unknown>;
	const totals = raw.totals as Record<string, Record<string, unknown>> | undefined;
	const largest = raw.largest as Record<string, Record<string, unknown>> | undefined;
	if (!totals?.raw || !totals.gzip || !largest?.gzip) {
		throw new Error(`${BUDGETS_PATH}: missing totals.raw / totals.gzip / largest.gzip`);
	}
	const out: Budgets = {
		totals: { raw: { js: 0, css: 0 }, gzip: { js: 0, css: 0 } },
		largest: { gzip: { js: 0, css: 0 } },
	};
	for (const b of BUCKETS) {
		out.totals.raw[b] = assertPositiveInt(totals.raw[b], `totals.raw.${b}`);
		out.totals.gzip[b] = assertPositiveInt(totals.gzip[b], `totals.gzip.${b}`);
		out.largest.gzip[b] = assertPositiveInt(largest.gzip[b], `largest.gzip.${b}`);
	}
	return out;
}

function bucketFor(name: string): Bucket | null {
	if (name.endsWith(".js")) return "js";
	if (name.endsWith(".css")) return "css";
	return null;
}

export function measure(assetsDir = ASSETS_DIR): Measurement {
	const out: Measurement = {
		totals: { raw: { js: 0, css: 0 }, gzip: { js: 0, css: 0 } },
		largest: { gzip: { js: 0, css: 0 } },
		files: [],
	};
	if (!existsSync(assetsDir)) return out;
	for (const entry of readdirSync(assetsDir)) {
		const full = join(assetsDir, entry);
		if (!statSync(full).isFile()) continue;
		const bucket = bucketFor(entry);
		if (!bucket) continue;
		const buf = readFileSync(full);
		const raw = buf.length;
		const gzip = gzipSync(buf).length;
		out.files.push({ name: entry, bucket, raw, gzip });
		out.totals.raw[bucket] += raw;
		out.totals.gzip[bucket] += gzip;
		if (gzip > out.largest.gzip[bucket]) out.largest.gzip[bucket] = gzip;
	}
	return out;
}

export function diff(measurement: Measurement, budgets: Budgets): Failure[] {
	const failures: Failure[] = [];
	for (const b of BUCKETS) {
		if (measurement.totals.raw[b] > budgets.totals.raw[b]) {
			failures.push({
				metric: "totals.raw",
				bucket: b,
				actual: measurement.totals.raw[b],
				budget: budgets.totals.raw[b],
			});
		}
		if (measurement.totals.gzip[b] > budgets.totals.gzip[b]) {
			failures.push({
				metric: "totals.gzip",
				bucket: b,
				actual: measurement.totals.gzip[b],
				budget: budgets.totals.gzip[b],
			});
		}
		if (measurement.largest.gzip[b] > budgets.largest.gzip[b]) {
			failures.push({
				metric: "largest.gzip",
				bucket: b,
				actual: measurement.largest.gzip[b],
				budget: budgets.largest.gzip[b],
			});
		}
	}
	return failures;
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	return `${(n / 1024).toFixed(2)} KiB (${n} B)`;
}

function runBuildUi(): void {
	console.log("Running `bun run build:ui` ...");
	const result = spawnSync("bun", ["run", "build:ui"], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
	if (result.status !== 0) {
		console.error("build:ui failed");
		process.exit(result.status ?? 1);
	}
}

function main(): void {
	const args = new Set(process.argv.slice(2));
	const shouldBuild = args.has("--build") || process.env.WARREN_BUNDLE_SIZE_BUILD === "1";
	if (shouldBuild) runBuildUi();

	if (!existsSync(ASSETS_DIR)) {
		console.error(`Bundle-size guard: ${ASSETS_DIR} does not exist.`);
		console.error("Run `bun run build:ui` first, or pass --build to this script.");
		process.exit(1);
	}

	const budgets = loadBudgets();
	const m = measure();

	console.log("Bundle-size measurement (src/ui/dist/assets/):");
	for (const f of m.files) {
		console.log(`  ${f.name}: raw ${fmtBytes(f.raw)}, gzip ${fmtBytes(f.gzip)}`);
	}
	for (const b of BUCKETS) {
		console.log(
			`  totals.${b}: raw ${fmtBytes(m.totals.raw[b])} / budget ${fmtBytes(budgets.totals.raw[b])}; gzip ${fmtBytes(m.totals.gzip[b])} / budget ${fmtBytes(budgets.totals.gzip[b])}; largest gzip ${fmtBytes(m.largest.gzip[b])} / budget ${fmtBytes(budgets.largest.gzip[b])}`,
		);
	}

	const failures = diff(m, budgets);
	if (failures.length > 0) {
		console.error("");
		console.error("Bundle-size guard failed:");
		for (const f of failures) {
			console.error(
				`  ${f.metric}.${f.bucket}: actual ${fmtBytes(f.actual)} exceeds budget ${fmtBytes(f.budget)} (+${f.actual - f.budget} B)`,
			);
		}
		console.error("");
		console.error(
			"Tip: see scripts/bundle-size-budgets.json — the ratchet only goes down. Code-split or trim deps rather than raising the budget.",
		);
		process.exit(1);
	}

	console.log("Bundle-size guard ok.");
}

if (import.meta.main) main();
