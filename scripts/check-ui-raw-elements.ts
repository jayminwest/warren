#!/usr/bin/env bun
/**
 * UI raw-element ratchet (warren-6772, plan pl-10db step 23).
 *
 * Two Biome GritQL plugins guard `src/ui/src/**\/*.tsx` outside
 * `src/ui/src/components/ui/**`:
 *
 *   - `.biome/plugins/no-raw-form-elements.grit` flags raw JSX
 *     `<button>`, `<input>`, `<select>`, and `<textarea>`.
 *   - `.biome/plugins/no-inline-style.grit` flags `style={...}` unless
 *     the value is a non-empty object literal whose every key is a
 *     quoted CSS custom property (`style={{ "--bar-h": h }}`), optionally
 *     wrapped in `as CSSProperties`.
 *
 * Files that predate the rules are grandfathered in
 * `scripts/ui-raw-elements-allowlist.json`, one entry per rule and file
 * carrying a tracker id and a `max` hit ceiling. Biome plugins cannot be
 * suppressed per file, so the allowlist is projected into a generated
 * block of `overrides` in `biome.jsonc` whose `includes` exclude the
 * grandfathered files. This script owns that block.
 *
 * Checks (all fail the gate):
 *   1. The allowlist is well-formed (known rule, in-scope path, tracker
 *      id, positive integer `max`).
 *   2. The generated block in `biome.jsonc` matches the allowlist.
 *   3. Every entry still has hits (stale entries fail) and exactly `max`
 *      of them: more means a new violation in a grandfathered file, fewer
 *      means the ceiling must come down.
 *   4. Against the base ref's allowlist (when git can resolve it), no new
 *      entry appears and no ceiling rises. The list only shrinks.
 *
 * `--write` regenerates the `biome.jsonc` block and lowers ceilings to
 * the measured counts (dropping entries at zero). It never raises one.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ALLOWLIST_REL = "scripts/ui-raw-elements-allowlist.json";
const BIOME_CONFIG_REL = "biome.jsonc";
const BIOME_BIN = resolve(REPO_ROOT, "node_modules/.bin/biome");

export const RULES = [
	{ id: "no-raw-form-elements", plugin: ".biome/plugins/no-raw-form-elements.grit" },
	{ id: "no-inline-style", plugin: ".biome/plugins/no-inline-style.grit" },
] as const;
export type RuleId = (typeof RULES)[number]["id"];

export const SCOPE_PREFIX = "src/ui/src/";
export const EXEMPT_PREFIX = "src/ui/src/components/ui/";
export const BEGIN_MARKER = "// BEGIN GENERATED ui-raw-elements";
export const END_MARKER = "// END GENERATED ui-raw-elements";
const TRACKER_RE = /^(?:warren|pl)-[0-9a-f]{4,}$/;

export type AllowlistEntry = { tracker: string; max: number };
export type Allowlist = Record<RuleId, Record<string, AllowlistEntry>>;
export type HitCounts = Record<RuleId, Map<string, number>>;

function emptyAllowlist(): Allowlist {
	return { "no-raw-form-elements": {}, "no-inline-style": {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryErrors(rule: string, path: string, value: unknown): string[] {
	const where = `${rule} → ${path}`;
	const errors: string[] = [];
	if (!path.startsWith(SCOPE_PREFIX) || !path.endsWith(".tsx")) {
		errors.push(`${where}: path must be a .tsx file under ${SCOPE_PREFIX}`);
	}
	if (path.startsWith(EXEMPT_PREFIX)) {
		errors.push(`${where}: ${EXEMPT_PREFIX} is exempt already; drop the entry`);
	}
	if (!isRecord(value)) return [...errors, `${where}: entry must be { tracker, max }`];
	if (typeof value.tracker !== "string" || !TRACKER_RE.test(value.tracker)) {
		errors.push(`${where}: tracker must be a warren-XXXX or pl-XXXX id`);
	}
	if (typeof value.max !== "number" || !Number.isInteger(value.max) || value.max < 1) {
		errors.push(`${where}: max must be a positive integer`);
	}
	return errors;
}

/** Validate the raw allowlist JSON and return the typed view plus every problem found. */
export function parseAllowlist(raw: unknown): { allowlist: Allowlist; errors: string[] } {
	const allowlist = emptyAllowlist();
	const errors: string[] = [];
	const rules = isRecord(raw) ? raw.rules : undefined;
	if (!isRecord(rules)) return { allowlist, errors: ["allowlist must have a `rules` object"] };
	const known = new Set<string>(RULES.map((r) => r.id));
	for (const [rule, files] of Object.entries(rules)) {
		if (!known.has(rule)) {
			errors.push(`unknown rule "${rule}" (expected one of ${[...known].join(", ")})`);
			continue;
		}
		if (!isRecord(files)) {
			errors.push(`${rule}: must map file paths to entries`);
			continue;
		}
		for (const [path, value] of Object.entries(files)) {
			const problems = entryErrors(rule, path, value);
			errors.push(...problems);
			if (problems.length === 0) allowlist[rule as RuleId][path] = value as AllowlistEntry;
		}
	}
	return { allowlist, errors };
}

/** Render the generated `overrides` block for biome.jsonc (two tab indents, trailing comma). */
export function renderSection(allowlist: Allowlist): string {
	const lines = [
		`\t\t${BEGIN_MARKER}: \`bun run check:ui-raw-elements --write\` rewrites this block`,
		`\t\t// from ${ALLOWLIST_REL}. Do not edit by hand.`,
	];
	for (const rule of RULES) {
		const includes = [
			`${SCOPE_PREFIX}**/*.tsx`,
			`!${EXEMPT_PREFIX}**`,
			...Object.keys(allowlist[rule.id])
				.sort()
				.map((p) => `!${p}`),
		];
		lines.push("\t\t{");
		lines.push('\t\t\t"includes": [');
		lines.push(includes.map((inc) => `\t\t\t\t${JSON.stringify(inc)}`).join(",\n"));
		lines.push("\t\t\t],");
		lines.push(`\t\t\t"plugins": [${JSON.stringify(`./${rule.plugin}`)}]`);
		lines.push("\t\t},");
	}
	lines.push(`\t\t${END_MARKER}`);
	return lines.join("\n");
}

/** Replace the marker-delimited block (marker lines included) in the config text. */
export function spliceSection(config: string, section: string): string {
	const begin = config.indexOf(BEGIN_MARKER);
	const end = config.indexOf(END_MARKER);
	if (begin === -1 || end === -1 || end < begin) {
		throw new Error(`${BIOME_CONFIG_REL} is missing the ${BEGIN_MARKER} / ${END_MARKER} markers`);
	}
	const lineStart = config.lastIndexOf("\n", begin) + 1;
	const lineEnd = end + END_MARKER.length;
	return `${config.slice(0, lineStart)}${section}${config.slice(lineEnd)}`;
}

/** Compare measured hits to the allowlist; return problems and the tightened allowlist. */
export function compareHits(
	allowlist: Allowlist,
	hits: HitCounts,
): { problems: string[]; tightened: Allowlist } {
	const problems: string[] = [];
	const tightened = emptyAllowlist();
	for (const rule of RULES) {
		for (const [path, entry] of Object.entries(allowlist[rule.id])) {
			const count = hits[rule.id].get(path) ?? 0;
			const where = `${rule.id} → ${path}`;
			if (count === 0) {
				problems.push(`${where}: stale entry, no hits remain; remove it`);
				continue;
			}
			tightened[rule.id][path] = { tracker: entry.tracker, max: Math.min(entry.max, count) };
			if (count > entry.max) {
				problems.push(`${where}: ${count} hits exceed the grandfathered max ${entry.max}`);
			} else if (count < entry.max) {
				problems.push(`${where}: ${count} hits, lower max from ${entry.max} to ${count}`);
			}
		}
	}
	return { problems, tightened };
}

/** The allowlist only shrinks: no new entries and no raised ceilings relative to the base. */
export function compareToBase(current: Allowlist, base: Allowlist): string[] {
	const problems: string[] = [];
	for (const rule of RULES) {
		for (const [path, entry] of Object.entries(current[rule.id])) {
			const prior = base[rule.id][path];
			if (prior === undefined) {
				problems.push(`${rule.id} → ${path}: new grandfathered entry; fix the file instead`);
			} else if (entry.max > prior.max) {
				problems.push(`${rule.id} → ${path}: max raised from ${prior.max} to ${entry.max}`);
			}
		}
	}
	return problems;
}

type BiomeDiagnostic = { category?: string; location?: { path?: string } };

/** Parse biome's `--reporter=json` stdout into per-file plugin hit counts. */
export function countPluginHits(stdout: string): Map<string, number> {
	const counts = new Map<string, number>();
	const jsonLine = stdout.split("\n").find((line) => line.startsWith("{"));
	if (jsonLine === undefined) throw new Error(`biome produced no JSON report:\n${stdout}`);
	const report = JSON.parse(jsonLine) as { diagnostics?: BiomeDiagnostic[] };
	for (const diag of report.diagnostics ?? []) {
		const path = diag.location?.path;
		if (diag.category !== "plugin" || path === undefined) continue;
		counts.set(path, (counts.get(path) ?? 0) + 1);
	}
	return counts;
}

/** Run one plugin (and nothing else) over `files` from `cwd`; return per-file hit counts. */
export function runPlugin(pluginAbs: string, files: string[], cwd: string): Map<string, number> {
	if (files.length === 0) return new Map();
	const dir = mkdtempSync(join(tmpdir(), "ui-raw-elements-"));
	try {
		const config = {
			linter: { enabled: true, rules: { recommended: false } },
			plugins: [pluginAbs],
		};
		writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
		const run = Bun.spawnSync(
			[
				BIOME_BIN,
				"lint",
				"--reporter=json",
				"--max-diagnostics=none",
				`--config-path=${dir}`,
				...files,
			],
			{ cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
		);
		return countPluginHits(run.stdout.toString());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function measureHits(allowlist: Allowlist): HitCounts {
	const hits = {} as HitCounts;
	for (const rule of RULES) {
		const files = Object.keys(allowlist[rule.id]).filter((p) => existsSync(join(REPO_ROOT, p)));
		hits[rule.id] = runPlugin(resolve(REPO_ROOT, rule.plugin), files, REPO_ROOT);
	}
	return hits;
}

function baseRef(): string {
	const explicit = process.env.UI_RAW_ELEMENTS_BASE_REF;
	if (explicit) return explicit;
	const ghBase = process.env.GITHUB_BASE_REF;
	return ghBase ? `origin/${ghBase}` : "origin/main";
}

function loadBaseAllowlist(ref: string): Allowlist | null {
	const proc = Bun.spawnSync(["git", "show", `${ref}:${ALLOWLIST_REL}`], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	if (proc.exitCode !== 0) return null;
	return parseAllowlist(JSON.parse(proc.stdout.toString())).allowlist;
}

function serializeAllowlist(raw: Record<string, unknown>, allowlist: Allowlist): string {
	const rules: Record<string, Record<string, AllowlistEntry>> = {};
	for (const rule of RULES) {
		const sorted = Object.entries(allowlist[rule.id]).sort(([a], [b]) => a.localeCompare(b));
		rules[rule.id] = Object.fromEntries(sorted);
	}
	return `${JSON.stringify({ ...raw, rules }, null, "\t")}\n`;
}

function report(problems: string[], heading: string): void {
	if (problems.length === 0) return;
	console.error(`check-ui-raw-elements: ${heading}`);
	for (const p of problems) console.error(`  - ${p}`);
}

function main(): void {
	const write = process.argv.includes("--write");
	const allowlistPath = join(REPO_ROOT, ALLOWLIST_REL);
	const configPath = join(REPO_ROOT, BIOME_CONFIG_REL);
	const raw = JSON.parse(readFileSync(allowlistPath, "utf8")) as Record<string, unknown>;
	const { allowlist, errors } = parseAllowlist(raw);
	report(errors, `${ALLOWLIST_REL} is malformed`);
	if (errors.length > 0) process.exit(1);

	const { problems, tightened } = compareHits(allowlist, measureHits(allowlist));
	const effective = write ? tightened : allowlist;
	const config = readFileSync(configPath, "utf8");
	const expected = spliceSection(config, renderSection(effective));
	if (write) {
		writeFileSync(allowlistPath, serializeAllowlist(raw, tightened));
		writeFileSync(configPath, expected);
	}
	const remaining = write ? problems.filter((p) => p.includes("exceed")) : problems;
	report(remaining, "allowlist does not match the plugin hits");
	const drift =
		!write && expected !== config
			? [`the generated block in ${BIOME_CONFIG_REL} is out of date; run with --write`]
			: [];
	report(drift, "biome.jsonc drift");

	const ref = baseRef();
	const base = loadBaseAllowlist(ref);
	const growth = base === null ? [] : compareToBase(effective, base);
	report(growth, `the allowlist grew relative to ${ref}; it only shrinks`);
	if (base === null)
		console.log(`check-ui-raw-elements: no allowlist at ${ref}, shrink check skipped`);

	const failed = remaining.length + drift.length + growth.length > 0;
	if (failed) process.exit(1);
	const total = RULES.reduce((n, r) => n + Object.keys(effective[r.id]).length, 0);
	console.log(`check-ui-raw-elements: ok (${total} grandfathered file entries)`);
}

if (import.meta.main) main();
