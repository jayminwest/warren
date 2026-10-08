#!/usr/bin/env bun
/**
 * Tailwind arbitrary-value ratchet (warren-7bc4, plan pl-10db step 19).
 *
 * Biome's `noTailwindArbitraryValue` rule has no baseline mode, and the UI
 * carried over a thousand arbitrary literals (`text-[10px]`, `w-[110px]`)
 * when this guard landed. So this script freezes a per-file count instead
 * and rides inside `bun run lint` until the total reaches zero. At zero a
 * follow-up swaps in Biome's rule and deletes this script.
 *
 * It walks every `.tsx` file under `src/ui/src/` (test files excluded) and
 * counts tokens that match `ARBITRARY_PATTERN`, then compares each file
 * against `scripts/tailwind-arbitrary-budgets.json`:
 *
 *   - A file listed in `budgets` must stay at or below its listed count.
 *   - A file absent from `budgets` must have zero hits.
 *
 * Two forms never count:
 *
 *   - The token-utility form `text-(--color-text-3)`. It names a design
 *     token, which is the fix this ratchet pushes toward.
 *   - Variants such as `data-[state=open]:`. A bracket followed by `:`
 *     selects a state; it is not a value.
 *
 * Usage:
 *   bun run scripts/check-tailwind-arbitrary.ts                # gate
 *   bun run scripts/check-tailwind-arbitrary.ts --update       # lower budgets
 *   bun run scripts/check-tailwind-arbitrary.ts --headroom 2   # warn, never fails
 *
 * `--update` only ever lowers a number or drops an entry. It refuses to
 * write when any file sits over its budget, because raising a number
 * defeats the guard. Move the literal onto a scale utility or a token in
 * `src/ui/src/tokens.css` instead.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseHeadroom } from "./check-file-sizes.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const BUDGETS_REL = "scripts/tailwind-arbitrary-budgets.json";
const SCAN_ROOT = "src/ui/src";
const TOP_OFFENDERS = 10;

/** `prefix-[value]`, the shape Biome's noTailwindArbitraryValue flags. */
export const ARBITRARY_PATTERN = /\b[a-z-]+-\[[^\]]+\]/g;

const COMMENT =
	"Tailwind arbitrary-value budgets (scripts/check-tailwind-arbitrary.ts, warren-7bc4). Per-file counts of prefix-[value] literals under src/ui/src. The ratchet only goes down: lower a number with `bun run check:tailwind-arbitrary --update`, never raise one. A file absent from `budgets` must have zero hits.";

type BudgetsFile = { _comment?: string; budgets: Record<string, number> };

export type Counts = Record<string, number>;
export type Failure = { path: string; count: number; budget: number };
export type ScanResult = {
	counts: Counts;
	failures: Failure[];
	staleBudgetEntries: string[];
};

/** Count arbitrary-value tokens in one source text. */
export function countArbitrary(source: string): number {
	let count = 0;
	for (const match of source.matchAll(ARBITRARY_PATTERN)) {
		const end = (match.index ?? 0) + match[0].length;
		if (source[end] === ":") continue;
		count++;
	}
	return count;
}

export function loadBudgets(root: string = REPO_ROOT): Record<string, number> {
	const path = resolve(root, BUDGETS_REL);
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BudgetsFile>;
	const budgets = raw.budgets;
	if (budgets === null || typeof budgets !== "object" || Array.isArray(budgets)) {
		throw new Error(`${path}: "budgets" must be an object`);
	}
	for (const [file, value] of Object.entries(budgets)) {
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			throw new Error(`${path}: budgets["${file}"] must be a positive integer`);
		}
	}
	return budgets;
}

function* walk(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) yield* walk(full);
		else if (st.isFile() && entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) yield full;
	}
}

/** Per-file hit counts for every scanned file with at least one hit. */
export function countTree(root: string = REPO_ROOT): Counts {
	const counts: Counts = {};
	for (const abs of walk(resolve(root, SCAN_ROOT))) {
		const n = countArbitrary(readFileSync(abs, "utf8"));
		if (n > 0) counts[relative(root, abs).replaceAll("\\", "/")] = n;
	}
	return counts;
}

/** Compare counts against budgets. Pure, so tests can drive it directly. */
export function compare(counts: Counts, budgets: Record<string, number>): ScanResult {
	const failures: Failure[] = [];
	for (const [path, count] of Object.entries(counts)) {
		const budget = budgets[path] ?? 0;
		if (count > budget) failures.push({ path, count, budget });
	}
	const staleBudgetEntries = Object.keys(budgets).filter((p) => counts[p] === undefined);
	failures.sort((a, b) => b.count - b.budget - (a.count - a.budget));
	return { counts, failures, staleBudgetEntries };
}

export function scan(root: string = REPO_ROOT): ScanResult {
	return compare(countTree(root), loadBudgets(root));
}

/**
 * The lowered budget map, or null when any file sits over its budget.
 * Files at zero hits drop out, so stale entries clear on the same pass.
 */
export function lowerBudgets(
	counts: Counts,
	budgets: Record<string, number>,
): Record<string, number> | null {
	if (compare(counts, budgets).failures.length > 0) return null;
	const next: Record<string, number> = {};
	for (const path of Object.keys(counts).sort()) {
		const count = counts[path] ?? 0;
		if (count > 0) next[path] = count;
	}
	return next;
}

export function writeBudgets(root: string, budgets: Record<string, number>): void {
	const body: BudgetsFile = { _comment: COMMENT, budgets };
	writeFileSync(resolve(root, BUDGETS_REL), `${JSON.stringify(body, null, "\t")}\n`);
}

function total(counts: Counts): number {
	return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function printTopOffenders(counts: Counts): void {
	const top = Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, TOP_OFFENDERS);
	console.error(`Top offending files (${total(counts)} hits in total):`);
	for (const [path, n] of top) console.error(`  ${String(n).padStart(4)}  ${path}`);
}

function printFailures(failures: readonly Failure[]): void {
	console.error("Tailwind arbitrary-value guard failed:");
	for (const f of failures) {
		const why =
			f.budget === 0
				? "file is not in the budget, so it must have zero hits"
				: "exceeds its frozen budget";
		console.error(`  ${f.path}: ${f.count} > ${f.budget} (${why})`);
	}
	console.error("");
	console.error(
		"Use a scale utility (text-xs, gap-1.5) or a src/ui/src/tokens.css token instead of a [px] literal.",
	);
	console.error(`Do not raise a number in ${BUDGETS_REL}; the ratchet only goes down.`);
}

function runUpdate(root: string): number {
	const counts = countTree(root);
	const budgets = loadBudgets(root);
	const next = lowerBudgets(counts, budgets);
	if (next === null) {
		printFailures(compare(counts, budgets).failures);
		console.error("--update refuses to raise a budget. Remove the new literals first.");
		return 1;
	}
	writeBudgets(root, next);
	console.log(`${BUDGETS_REL} rewritten: ${total(budgets)} -> ${total(next)} budgeted hits.`);
	return 0;
}

function runHeadroom(root: string, n: number): number {
	const counts = countTree(root);
	const budgets = loadBudgets(root);
	const near = Object.entries(budgets)
		.map(([path, budget]) => ({ path, budget, count: counts[path] ?? 0 }))
		.filter((m) => m.budget - m.count <= n)
		.sort((a, b) => a.budget - a.count - (b.budget - b.count));
	if (near.length === 0) {
		console.log(`No file is within ${n} hits of its ceiling.`);
		return 0;
	}
	console.log(`Within ${n} hits of the ceiling (${near.length}):`);
	for (const m of near) console.log(`  ${m.path}: ${m.count}/${m.budget}`);
	return 0;
}

function runGate(root: string): number {
	const { counts, failures, staleBudgetEntries } = scan(root);
	if (staleBudgetEntries.length > 0) {
		console.error(`${BUDGETS_REL} lists files with no hits left (or no file at all):`);
		for (const p of staleBudgetEntries) console.error(`  - ${p}`);
		console.error("");
	}
	if (failures.length > 0) {
		printFailures(failures);
		console.error("");
		printTopOffenders(counts);
	}
	if (failures.length > 0 || staleBudgetEntries.length > 0) {
		console.error("");
		console.error("Lower stale or shrunk budgets with: bun run check:tailwind-arbitrary --update");
		console.error("re-run: bun run check:tailwind-arbitrary");
		return 1;
	}
	console.log(`Tailwind arbitrary-value guard ok (${total(counts)} hits under budget).`);
	return 0;
}

export function main(argv: readonly string[], root: string = REPO_ROOT): number {
	if (argv.includes("--update")) return runUpdate(root);
	const headroom = parseHeadroom(argv);
	if (headroom !== null) return runHeadroom(root, headroom);
	return runGate(root);
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
