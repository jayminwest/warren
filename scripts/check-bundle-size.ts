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
 *   bun run scripts/check-bundle-size.ts --build --update
 *                                                    # build, then WRITE budgets =
 *                                                    # measured + headroom (re-baseline)
 *
 * If `src/ui/dist/` is missing the script exits non-zero with a hint
 * unless `--build` (or `WARREN_BUNDLE_SIZE_BUILD=1`) is set.
 *
 * Parity, two traps that have bitten us (warren-bfc6):
 *   1. Vite's build-log gzip figure runs ~2KB COOLER than this script's
 *      Node-zlib gzip. Budget from THIS script, never from Vite's reporter.
 *   2. A stale local `src/ui/node_modules` can carry different dep versions
 *      than the committed lockfile and produce a different bundle than CI.
 *      `build:ui` installs with --frozen-lockfile precisely so a clean local
 *      build is byte-identical to CI; if your numbers disagree with CI, blow
 *      away node_modules and rebuild rather than padding the budget.
 *
 * Re-baselining: never hand-edit the numbers in bundle-size-budgets.json. Run
 * `--update` instead: it writes budgets straight from the measured build plus a
 * small churn headroom (HEADROOM_RAW/_GZIP) using the SAME Node-zlib gzip the
 * guard enforces, so a budget it writes is guaranteed to pass the check (this
 * is what closes the Vite-vs-guard parity gap — agents stop copying Vite's
 * cooler build-log number). Raising is bounded: a growth within `AUTO_RAISE_CAP`
 * re-baselines hands-free, but a larger jump (a heavy new dep) is refused unless
 * WARREN_BUNDLE_SIZE_ALLOW_RAISE=1 is set (a knowing new floor). Lowering always
 * applies — the ratchet still pulls down.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Headroom added to a measured size when re-baselining via --update (js bucket;
 * css uses half). The build is byte-reproducible across machines as long as
 * deps come from the committed lockfile (build:ui installs --frozen-lockfile),
 * so this is only a small churn buffer for trivial follow-up changes, NOT a
 * cross-platform fudge factor — local and CI measure identical bytes.
 */
const HEADROOM_RAW = 800;
const HEADROOM_GZIP = 400;

/**
 * Bounded auto-raise cap for `--update` (warren bundle-size noise fix). The
 * historic ratchet refused to raise ANY budget without
 * WARREN_BUNDLE_SIZE_ALLOW_RAISE=1, which pushed agents into hand-editing the
 * JSON from Vite's build-log gzip number — that figure runs ~2KB cooler than
 * this guard, so the budget landed too tight and CI tripped by a few hundred
 * bytes to ~2KB (the only failure mode we ever saw). `--update` now lets a
 * budget grow without the override AS LONG AS the increase stays within these
 * per-metric caps, so ordinary feature churn re-baselines frictionlessly while
 * a genuinely surprising jump (a heavy new dep) still hits the refusal path and
 * forces a human ack via WARREN_BUNDLE_SIZE_ALLOW_RAISE=1. Caps are absolute
 * bytes per bucket; raw tracks ~3x gzip. Tune here, not by padding budgets.
 */
const AUTO_RAISE_CAP: { raw: Record<Bucket, number>; gzip: Record<Bucket, number> } = {
	raw: { js: 24576, css: 6144 },
	gzip: { js: 8192, css: 2048 },
};

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

export type UpdateResult = { wrote: boolean; raised: string[]; autoRaised: string[] };

/**
 * Re-baseline budgets from a measurement: budget = measured + headroom, written
 * straight back into bundle-size-budgets.json (numeric fields only; all
 * `$comment*` keys and ordering are preserved). Lowering a budget always
 * applies. Raising is allowed without `allowRaise` only when the increase stays
 * within `AUTO_RAISE_CAP` (ordinary churn re-baselines hands-free); a larger
 * jump is refused, nothing is written, and the offending metrics are returned
 * in `raised` for a deliberate WARREN_BUNDLE_SIZE_ALLOW_RAISE=1 override.
 * Metrics that grew but stayed within the cap are reported in `autoRaised`.
 */
export function updateBudgets(
	measurement: Measurement,
	budgetsPath = BUDGETS_PATH,
	allowRaise = process.env.WARREN_BUNDLE_SIZE_ALLOW_RAISE === "1",
): UpdateResult {
	const raw = JSON.parse(readFileSync(budgetsPath, "utf8")) as Record<string, unknown>;
	const totals = raw.totals as Budgets["totals"];
	const largest = raw.largest as Budgets["largest"];
	const raised: string[] = [];
	const autoRaised: string[] = [];

	const apply = (
		current: number,
		measured: number,
		headroom: number,
		cap: number,
		label: string,
	): number => {
		const next = measured + headroom;
		if (next <= current) return next;
		if (allowRaise) return next;
		const delta = next - current;
		if (delta <= cap) {
			autoRaised.push(`${label}: ${current} → ${next} (+${delta} B, within ${cap} B cap)`);
			return next;
		}
		raised.push(`${label}: ${current} → ${next} (+${delta} B, exceeds ${cap} B cap)`);
		return current;
	};

	for (const b of BUCKETS) {
		const hRaw = b === "js" ? HEADROOM_RAW : Math.round(HEADROOM_RAW / 2);
		const hGzip = b === "js" ? HEADROOM_GZIP : Math.round(HEADROOM_GZIP / 2);
		totals.raw[b] = apply(
			totals.raw[b],
			measurement.totals.raw[b],
			hRaw,
			AUTO_RAISE_CAP.raw[b],
			`totals.raw.${b}`,
		);
		totals.gzip[b] = apply(
			totals.gzip[b],
			measurement.totals.gzip[b],
			hGzip,
			AUTO_RAISE_CAP.gzip[b],
			`totals.gzip.${b}`,
		);
		largest.gzip[b] = apply(
			largest.gzip[b],
			measurement.largest.gzip[b],
			hGzip,
			AUTO_RAISE_CAP.gzip[b],
			`largest.gzip.${b}`,
		);
	}

	if (raised.length > 0) return { wrote: false, raised, autoRaised };

	writeFileSync(budgetsPath, `${JSON.stringify(raw, null, "\t")}\n`);
	return { wrote: true, raised, autoRaised };
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

function runUpdate(m: Measurement): void {
	const { wrote, raised, autoRaised } = updateBudgets(m);
	if (!wrote) {
		console.error("");
		console.error("Bundle-size --update refused to RAISE budgets beyond the auto-raise cap:");
		for (const r of raised) console.error(`  ${r}`);
		console.error("");
		console.error(
			"That much growth should be a deliberate new floor (e.g. a heavy new dep). Re-run with WARREN_BUNDLE_SIZE_ALLOW_RAISE=1 and document why in a $comment.",
		);
		process.exit(1);
	}
	console.log(`Wrote re-baselined budgets to ${BUDGETS_PATH} (measured + headroom).`);
	for (const r of autoRaised) console.log(`  auto-raised ${r}`);
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

	const m = measure();

	console.log("Bundle-size measurement (src/ui/dist/assets/):");
	for (const f of m.files) {
		console.log(`  ${f.name}: raw ${fmtBytes(f.raw)}, gzip ${fmtBytes(f.gzip)}`);
	}

	if (args.has("--update")) {
		runUpdate(m);
		return;
	}

	const budgets = loadBudgets();
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
			"Tip: do NOT hand-edit scripts/bundle-size-budgets.json from Vite's build-log gzip number — it runs ~2KB cooler than this guard, so eyeballed budgets fail CI. Re-baseline with `bun run check:bundle-size:build --update`, which writes the authoritative measured numbers; ordinary growth auto-raises within the cap, a heavy new dep still needs WARREN_BUNDLE_SIZE_ALLOW_RAISE=1. Then commit the budget diff (or code-split / trim deps to stay flat).",
		);
		process.exit(1);
	}

	console.log("Bundle-size guard ok.");
}

if (import.meta.main) main();
