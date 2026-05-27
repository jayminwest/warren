#!/usr/bin/env bun
/**
 * Per-file line-count guard (warren-4553, plan pl-7b06 step 7).
 *
 * Walks every TypeScript file under `src/` and `scripts/` (excluding
 * `src/ui/`, `__golden__/`, and `node_modules/`) and enforces a budget
 * recorded in `scripts/file-size-budgets.json`:
 *
 *   - Files NOT listed in `budgets` must be ≤ `threshold` lines.
 *   - Files listed in `budgets` must be ≤ their listed budget. The
 *     listed budget is a frozen ceiling (the file's line count at the
 *     time it was grandfathered in) — the ratchet only goes down.
 *
 * To shrink a budget, refactor the file then lower the number (or remove
 * the entry entirely once the file is below `threshold`). To grow past
 * the ceiling: refactor first; do NOT raise the number — that would
 * defeat the guard.
 *
 * Companion: Biome's `noExcessiveLinesPerFunction` rule (configured in
 * `biome.json`) enforces a per-function ceiling. This script enforces a
 * per-file ceiling — Biome has no equivalent built-in for that.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUDGETS_PATH = resolve(REPO_ROOT, "scripts/file-size-budgets.json");

const SCAN_ROOTS = ["src", "scripts"] as const;
const EXTENSIONS = [".ts", ".tsx"] as const;
const EXCLUDE_DIR_SEGMENTS = ["node_modules", "__golden__"] as const;
const EXCLUDE_PATH_PREFIXES = ["src/ui/"] as const;

type BudgetsFile = {
	threshold: number;
	budgets: Record<string, number>;
};

function loadBudgets(): BudgetsFile {
	const raw = JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as Record<string, unknown>;
	const threshold = raw.threshold;
	const budgets = raw.budgets;
	if (typeof threshold !== "number" || threshold <= 0) {
		throw new Error(`${BUDGETS_PATH}: "threshold" must be a positive number`);
	}
	if (budgets === null || typeof budgets !== "object" || Array.isArray(budgets)) {
		throw new Error(`${BUDGETS_PATH}: "budgets" must be an object`);
	}
	const normalized: Record<string, number> = {};
	for (const [path, value] of Object.entries(budgets)) {
		if (typeof value !== "number" || value <= 0) {
			throw new Error(`${BUDGETS_PATH}: budgets["${path}"] must be a positive number`);
		}
		normalized[path] = value;
	}
	return { threshold, budgets: normalized };
}

function shouldExclude(relPath: string): boolean {
	for (const prefix of EXCLUDE_PATH_PREFIXES) {
		if (relPath.startsWith(prefix)) return true;
	}
	return false;
}

function* walk(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		if ((EXCLUDE_DIR_SEGMENTS as readonly string[]).includes(entry)) continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (st.isFile()) {
			yield full;
		}
	}
}

function countLines(filePath: string): number {
	const buf = readFileSync(filePath);
	if (buf.length === 0) return 0;
	// `wc -l` semantics: count newline bytes.
	let count = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0x0a) count++;
	}
	return count;
}

function isTsFile(name: string): boolean {
	return EXTENSIONS.some((ext) => name.endsWith(ext));
}

type Failure = { path: string; lines: number; budget: number; reason: string };

export function scan(): { failures: Failure[]; staleBudgetEntries: string[] } {
	const { threshold, budgets } = loadBudgets();
	const failures: Failure[] = [];
	const seenInWalk = new Set<string>();

	const roots: string[] = [];
	for (const r of SCAN_ROOTS) roots.push(resolve(REPO_ROOT, r));
	// drizzle.config.ts is single-file and lives at repo root; include it
	// explicitly since it's covered by biome.json's includes list.
	const extraFiles = [resolve(REPO_ROOT, "drizzle.config.ts")];

	const allFiles: string[] = [];
	for (const root of roots) {
		for (const f of walk(root)) allFiles.push(f);
	}
	for (const f of extraFiles) {
		if (existsSync(f)) allFiles.push(f);
	}

	for (const abs of allFiles) {
		const rel = relative(REPO_ROOT, abs).replaceAll("\\", "/");
		if (!isTsFile(rel)) continue;
		if (shouldExclude(rel)) continue;
		seenInWalk.add(rel);

		const lines = countLines(abs);
		const explicit = budgets[rel];
		if (explicit !== undefined) {
			if (lines > explicit) {
				failures.push({
					path: rel,
					lines,
					budget: explicit,
					reason: `exceeds frozen budget (${lines} > ${explicit}); refactor instead of raising the budget`,
				});
			}
		} else if (lines > threshold) {
			failures.push({
				path: rel,
				lines,
				budget: threshold,
				reason: `exceeds default threshold (${lines} > ${threshold}); split the file or add a justified entry to scripts/file-size-budgets.json`,
			});
		}
	}

	const staleBudgetEntries: string[] = [];
	for (const path of Object.keys(budgets)) {
		if (!seenInWalk.has(path)) staleBudgetEntries.push(path);
	}

	return { failures, staleBudgetEntries };
}

function main(): void {
	const { failures, staleBudgetEntries } = scan();

	if (staleBudgetEntries.length > 0) {
		console.error("scripts/file-size-budgets.json has entries for files that no longer exist:");
		for (const p of staleBudgetEntries) console.error(`  - ${p}`);
		console.error("Remove these entries to keep the budget honest.");
		console.error("");
	}

	if (failures.length > 0) {
		console.error("File-size guard failed:");
		for (const f of failures) {
			console.error(`  ${f.path}: ${f.reason}`);
		}
		console.error("");
		console.error(
			`Tip: see scripts/file-size-budgets.json — the ratchet only goes down. Refactor large files into smaller modules rather than raising their budget.`,
		);
		process.exit(1);
	}

	if (staleBudgetEntries.length > 0) process.exit(1);

	console.log("File-size guard ok.");
}

if (import.meta.main) main();
