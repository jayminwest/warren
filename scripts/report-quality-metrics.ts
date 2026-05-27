#!/usr/bin/env bun
/**
 * report-quality-metrics.ts (warren-5b95 / pl-7b06 step 18)
 *
 * Emits a consolidated "code-quality metrics" summary into the GitHub
 * Actions step summary (and stdout for local runs). It does NOT enforce
 * anything — each underlying guard (`check-coverage`, biome's complexity
 * rules, `check-file-sizes`, `check-bundle-size`, `check-debt-markers`)
 * already fails the build when its ratchet is breached. This report
 * just makes the current state visible in one place so reviewers can
 * see trends at a glance without digging through individual logs.
 *
 * Inputs (all optional — missing artifacts produce a "—" cell rather
 * than a failure, so the script is safe to run before/after coverage):
 *
 *   coverage/summary.json            — line + function totals (preferred, written by check-coverage.ts)
 *   coverage/lcov.info               — line + function totals (fallback only; diverges from Bun text reporter)
 *   scripts/coverage-budgets.json    — coverage floors
 *   biome.json                       — complexity & line-per-fn overrides
 *   scripts/file-size-budgets.json   — grandfathered file-size entries
 *   scripts/debt-marker-allowlist.json — grandfathered debt markers
 *   src/ui/dist/assets/              — bundle sizes (raw + gzip)
 *   scripts/bundle-size-budgets.json — bundle-size ceilings
 *
 * Usage:
 *   bun run scripts/report-quality-metrics.ts
 *   bun run scripts/report-quality-metrics.ts --lcov path/to/lcov.info
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const REPO_ROOT = resolve(import.meta.dir, "..");

export interface CoverageTotals {
	functions: { hit: number; found: number; pct: number };
	lines: { hit: number; found: number; pct: number };
}

/**
 * Parse an lcov.info file into aggregate function + line totals.
 *
 * lcov record fields:
 *   FNF: <count>   — functions found
 *   FNH: <count>   — functions hit
 *   LF:  <count>   — lines found
 *   LH:  <count>   — lines hit
 *
 * We sum across all SF blocks; that matches the "All files" aggregate
 * Bun's text reporter prints (functions% = hit/found, lines% same).
 * Returns `undefined` if the file has no usable records.
 */
export function parseLcov(input: string): CoverageTotals | undefined {
	let fnf = 0;
	let fnh = 0;
	let lf = 0;
	let lh = 0;
	let saw = false;
	for (const rawLine of input.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon);
		const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
		if (!Number.isFinite(value)) continue;
		switch (key) {
			case "FNF":
				fnf += value;
				saw = true;
				break;
			case "FNH":
				fnh += value;
				saw = true;
				break;
			case "LF":
				lf += value;
				saw = true;
				break;
			case "LH":
				lh += value;
				saw = true;
				break;
		}
	}
	if (!saw) return undefined;
	const fnPct = fnf === 0 ? 100 : (fnh / fnf) * 100;
	const linePct = lf === 0 ? 100 : (lh / lf) * 100;
	return {
		functions: { hit: fnh, found: fnf, pct: fnPct },
		lines: { hit: lh, found: lf, pct: linePct },
	};
}

export interface ComplexityOverrides {
	cognitive: number;
	linesPerFunction: number;
}

/**
 * Count files grandfathered out of biome's two complexity rules by
 * scanning biome.json's `overrides` array. Any override block whose
 * `linter.rules.complexity.<rule>` is "off" contributes its `includes`
 * count. We don't try to dedupe across multiple blocks — by convention
 * each file appears in at most one override block per rule.
 */
export function countComplexityOverrides(biomeJson: string): ComplexityOverrides {
	const parsed = JSON.parse(biomeJson) as {
		overrides?: Array<{
			includes?: string[];
			linter?: { rules?: { complexity?: Record<string, unknown> } };
		}>;
	};
	let cognitive = 0;
	let linesPerFunction = 0;
	for (const block of parsed.overrides ?? []) {
		const rules = block.linter?.rules?.complexity;
		if (!rules) continue;
		const includes = block.includes ?? [];
		if (rules.noExcessiveCognitiveComplexity === "off") cognitive += includes.length;
		if (rules.noExcessiveLinesPerFunction === "off") linesPerFunction += includes.length;
	}
	return { cognitive, linesPerFunction };
}

export interface FileSizeBudgets {
	threshold: number;
	grandfathered: number;
	largest: number;
}

export function summariseFileSizes(budgetsJson: string): FileSizeBudgets {
	const parsed = JSON.parse(budgetsJson) as {
		threshold?: number;
		budgets?: Record<string, number>;
	};
	const budgets = parsed.budgets ?? {};
	const values = Object.values(budgets);
	return {
		threshold: parsed.threshold ?? 0,
		grandfathered: values.length,
		largest: values.length === 0 ? 0 : Math.max(...values),
	};
}

export interface DebtMarkers {
	grandfathered: number;
}

export function summariseDebt(allowlistJson: string): DebtMarkers {
	const parsed = JSON.parse(allowlistJson) as { allowlist?: unknown[] };
	return { grandfathered: (parsed.allowlist ?? []).length };
}

export interface BundleSizes {
	rawJs: number;
	rawCss: number;
	gzipJs: number;
	gzipCss: number;
	budgetRawJs: number;
	budgetRawCss: number;
	budgetGzipJs: number;
	budgetGzipCss: number;
}

/**
 * Measure src/ui/dist/assets/ totals (raw + gzip per extension) and
 * pair them with the recorded budget. Returns `undefined` if the build
 * output is missing — the build step in CI must run before this one
 * for bundle numbers to surface.
 */
export function measureBundleSizes(
	distAssetsDir: string,
	budgetsJson: string,
): BundleSizes | undefined {
	if (!existsSync(distAssetsDir)) return undefined;
	const budgets = JSON.parse(budgetsJson) as {
		totals?: { raw?: Record<string, number>; gzip?: Record<string, number> };
	};
	let rawJs = 0;
	let rawCss = 0;
	let gzipJs = 0;
	let gzipCss = 0;
	for (const name of readdirSync(distAssetsDir)) {
		const full = join(distAssetsDir, name);
		const st = statSync(full);
		if (!st.isFile()) continue;
		const buf = readFileSync(full);
		const gz = gzipSync(buf).length;
		if (name.endsWith(".js")) {
			rawJs += buf.length;
			gzipJs += gz;
		} else if (name.endsWith(".css")) {
			rawCss += buf.length;
			gzipCss += gz;
		}
	}
	return {
		rawJs,
		rawCss,
		gzipJs,
		gzipCss,
		budgetRawJs: budgets.totals?.raw?.js ?? 0,
		budgetRawCss: budgets.totals?.raw?.css ?? 0,
		budgetGzipJs: budgets.totals?.gzip?.js ?? 0,
		budgetGzipCss: budgets.totals?.gzip?.css ?? 0,
	};
}

function fmtBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}

function fmtPct(actual: number, floor: number): string {
	const delta = actual - floor;
	const sign = delta >= 0 ? "+" : "";
	return `${actual.toFixed(2)}% (floor ${floor.toFixed(2)}%, ${sign}${delta.toFixed(2)}pt)`;
}

function fmtBudgetCell(actual: number, budget: number): string {
	if (budget === 0) return fmtBytes(actual);
	const pct = (actual / budget) * 100;
	return `${fmtBytes(actual)} / ${fmtBytes(budget)} (${pct.toFixed(1)}%)`;
}

export interface ReportInputs {
	summaryJson: string | undefined;
	lcov: string | undefined;
	coverageBudgets: string | undefined;
	biomeJson: string | undefined;
	fileSizeBudgets: string | undefined;
	debtAllowlist: string | undefined;
	bundleSizes: BundleSizes | undefined;
}

/**
 * Resolve coverage percentages, preferring the JSON summary written by
 * check-coverage.ts (which matches Bun's text-reporter "All files" row
 * exactly) and falling back to parsing lcov.info when the summary
 * artifact is absent.
 */
function parseSummaryJson(summaryJson: string): { functions?: number; lines?: number } {
	try {
		const parsed = JSON.parse(summaryJson) as { functions?: number; lines?: number };
		return {
			functions: typeof parsed.functions === "number" ? parsed.functions : undefined,
			lines: typeof parsed.lines === "number" ? parsed.lines : undefined,
		};
	} catch {
		return {};
	}
}

function resolveCoverage(
	summaryJson: string | undefined,
	lcov: string | undefined,
): { functions: number; lines: number } | undefined {
	const fromSummary = summaryJson ? parseSummaryJson(summaryJson) : {};
	const fromLcov = lcov ? parseLcov(lcov) : undefined;
	const functions = fromSummary.functions ?? fromLcov?.functions.pct;
	const lines = fromSummary.lines ?? fromLcov?.lines.pct;
	if (functions === undefined || lines === undefined) return undefined;
	return { functions, lines };
}

function renderCoverageRows(inputs: ReportInputs): string[] {
	const totals = resolveCoverage(inputs.summaryJson, inputs.lcov);
	if (!totals || !inputs.coverageBudgets) {
		return ["| Coverage | — (summary.json/lcov.info or budgets missing) |"];
	}
	const floors = JSON.parse(inputs.coverageBudgets) as { functions: number; lines: number };
	return [
		`| Coverage — functions | ${fmtPct(totals.functions, floors.functions)} |`,
		`| Coverage — lines | ${fmtPct(totals.lines, floors.lines)} |`,
	];
}

function renderComplexityRows(biomeJson: string | undefined): string[] {
	if (!biomeJson) return [];
	const c = countComplexityOverrides(biomeJson);
	return [
		`| Complexity — files exempt from cognitive-complexity ≤ 15 | ${c.cognitive} |`,
		`| Complexity — files exempt from lines-per-function ≤ 500 | ${c.linesPerFunction} |`,
	];
}

function renderRatchetRows(inputs: ReportInputs): string[] {
	const rows: string[] = [];
	if (inputs.fileSizeBudgets) {
		const fs = summariseFileSizes(inputs.fileSizeBudgets);
		rows.push(
			`| File-size budget — grandfathered files | ${fs.grandfathered} (largest ${fs.largest} lines vs ${fs.threshold} threshold) |`,
		);
	}
	if (inputs.debtAllowlist) {
		const d = summariseDebt(inputs.debtAllowlist);
		rows.push(`| Untracked debt markers — grandfathered | ${d.grandfathered} |`);
	}
	return rows;
}

function renderBundleRows(bundleSizes: BundleSizes | undefined): string[] {
	if (!bundleSizes) {
		return ["| Bundle sizes | — (src/ui/dist/assets/ missing — run build:ui first) |"];
	}
	const b = bundleSizes;
	return [
		`| Bundle — JS gzip | ${fmtBudgetCell(b.gzipJs, b.budgetGzipJs)} |`,
		`| Bundle — CSS gzip | ${fmtBudgetCell(b.gzipCss, b.budgetGzipCss)} |`,
		`| Bundle — JS raw | ${fmtBudgetCell(b.rawJs, b.budgetRawJs)} |`,
		`| Bundle — CSS raw | ${fmtBudgetCell(b.rawCss, b.budgetRawCss)} |`,
	];
}

export function formatReport(inputs: ReportInputs): string {
	const lines: string[] = [
		"## Code-quality metrics",
		"",
		"| Metric | Value |",
		"| --- | --- |",
		...renderCoverageRows(inputs),
		...renderComplexityRows(inputs.biomeJson),
		...renderRatchetRows(inputs),
		...renderBundleRows(inputs.bundleSizes),
		"",
		"<sub>All numbers above are enforced by individual ratchet scripts; this panel is a passive summary.</sub>",
		"",
	];
	return lines.join("\n");
}

function readIfExists(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function parseArgs(argv: string[]): { lcovPath: string } {
	let lcovPath = resolve(REPO_ROOT, "coverage/lcov.info");
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--lcov") {
			const next = argv[i + 1];
			if (next) {
				lcovPath = resolve(next);
				i++;
			}
		}
	}
	return { lcovPath };
}

async function main(): Promise<void> {
	const { lcovPath } = parseArgs(process.argv.slice(2));
	const bundleBudgetsPath = resolve(REPO_ROOT, "scripts/bundle-size-budgets.json");
	const bundleBudgetsJson = readIfExists(bundleBudgetsPath);
	const bundleSizes =
		bundleBudgetsJson === undefined
			? undefined
			: measureBundleSizes(resolve(REPO_ROOT, "src/ui/dist/assets"), bundleBudgetsJson);

	const formatted = formatReport({
		summaryJson: readIfExists(resolve(REPO_ROOT, "coverage/summary.json")),
		lcov: readIfExists(lcovPath),
		coverageBudgets: readIfExists(resolve(REPO_ROOT, "scripts/coverage-budgets.json")),
		biomeJson: readIfExists(resolve(REPO_ROOT, "biome.json")),
		fileSizeBudgets: readIfExists(resolve(REPO_ROOT, "scripts/file-size-budgets.json")),
		debtAllowlist: readIfExists(resolve(REPO_ROOT, "scripts/debt-marker-allowlist.json")),
		bundleSizes,
	});

	console.log(formatted);
	const stepSummary = process.env.GITHUB_STEP_SUMMARY;
	if (stepSummary) {
		appendFileSync(stepSummary, `${formatted}\n`);
	}
}

if (import.meta.main) {
	await main();
}
