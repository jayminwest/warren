#!/usr/bin/env bun
/**
 * The ui-design-review verdict contract (warren-7d12, plan pl-10db step 14).
 *
 * The evaluator skill (`.claude/skills/ui-design-review/SKILL.md`) writes a
 * verdict JSON against the rubric in `docs/design/ui-design-review.md`. This
 * module is the one parser for that file. The evaluator runs it to check its
 * own output before it stops, and the design-review workflow (warren-a694)
 * runs it to decide the status check. The workflow trusts the verdict this
 * module computes from the findings, never the model's own `verdict` field
 * alone: a mismatch makes the file invalid.
 *
 * Pure apart from the CLI block at the bottom (type-only imports plus the
 * pure page manifest), so `bun test` loads it directly.
 *
 * Usage:
 *   bun run scripts/design-review/verdict.ts <verdict.json> [--ci-meta <ci-meta.json>]
 *
 * Prints one JSON line `{ ok, verdict, counts, errors }` and exits
 *   0  valid and PASS
 *   1  valid and FAIL
 *   2  invalid or unreadable (the check fails closed)
 */

import { readFileSync } from "node:fs";
import { PAGES, THEMES, VIEWPORT_NAMES } from "../ui-visual/pages.ts";

export const VERDICT_SCHEMA = "warren-ui-design-review/v1";
export const RUBRIC_VERSION = 1;

/** Rubric criterion ids, in rubric order. The design record has one section per id. */
export const CRITERIA = [
	"evidence-complete",
	"smoke-clean",
	"hierarchy",
	"type-scale",
	"spacing-rhythm",
	"primitive-consistency",
	"state-coverage",
	"operator-copy",
	"orphaned-controls",
	"phone-layout",
	"theme-parity",
] as const;
export type CriterionId = (typeof CRITERIA)[number];

/** Ranked most severe first; the order findings sort in. */
export const SEVERITIES = ["blocker", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ORIGINS = ["diff", "pre-existing"] as const;
export type Origin = (typeof ORIGINS)[number];

/** Pseudo page id for the console shell (sidebar, topbar, bottom nav) on every page. */
export const SHELL_PAGE = "shell";
export const BOTH = "both";

/** PASS needs zero counted blockers and at most this many counted majors. */
export const MAX_MAJORS = 2;
/** Cap on the one-line `issue`, `fix`, and `evidence` fields. */
export const MAX_LINE = 200;
export const MAX_SUMMARY = 600;

export interface Finding {
	readonly criterion: CriterionId;
	readonly severity: Severity;
	readonly origin: Origin;
	readonly page: string;
	readonly viewport: string;
	readonly theme: string;
	readonly evidence: string;
	readonly issue: string;
	readonly fix: string;
}

export interface Verdict {
	readonly schema: typeof VERDICT_SCHEMA;
	readonly rubric: typeof RUBRIC_VERSION;
	readonly headSha: string;
	readonly verdict: "pass" | "fail";
	readonly pagesInScope: readonly string[];
	readonly casesReviewed: readonly string[];
	readonly findings: readonly Finding[];
	readonly summary: string;
}

export type Counts = Record<Severity, number>;

export interface Decision {
	readonly verdict: "pass" | "fail";
	/** Findings with origin `diff`: the only ones the verdict counts. */
	readonly counts: Counts;
}

export type ParseResult =
	| { readonly ok: true; readonly value: Verdict; readonly decision: Decision }
	| { readonly ok: false; readonly errors: readonly string[] };

const TOP_KEYS = [
	"schema",
	"rubric",
	"headSha",
	"verdict",
	"pagesInScope",
	"casesReviewed",
	"findings",
	"summary",
] as const;
const FINDING_KEYS = [
	"criterion",
	"severity",
	"origin",
	"page",
	"viewport",
	"theme",
	"evidence",
	"issue",
	"fix",
] as const;

const PAGE_IDS: readonly string[] = PAGES.map((p) => p.id);
const SHA = /^[0-9a-f]{7,40}$/;

/** Apply the rubric's pass rule to the findings that came from the diff. */
export function decide(findings: readonly Pick<Finding, "severity" | "origin">[]): Decision {
	const counts: Counts = { blocker: 0, major: 0, minor: 0 };
	for (const f of findings) {
		if (f.origin === "diff") counts[f.severity] += 1;
	}
	const pass = counts.blocker === 0 && counts.major <= MAX_MAJORS;
	return { verdict: pass ? "pass" : "fail", counts };
}

/** Findings ranked blocker, major, minor; diff before pre-existing; stable otherwise. */
export function rankFindings(findings: readonly Finding[]): Finding[] {
	const rank = (f: Finding): number =>
		SEVERITIES.indexOf(f.severity) * 2 + (f.origin === "diff" ? 0 : 1);
	return findings
		.map((f, i) => ({ f, i }))
		.sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
		.map((x) => x.f);
}

/** Every `<page>.<viewport>.<theme>` case name for a page. */
export function caseNames(page: string): string[] {
	return VIEWPORT_NAMES.flatMap((v) => THEMES.map((t) => `${page}.${v}.${t}`));
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
	return typeof value === "string" && allowed.includes(value);
}

function unknownKeys(obj: Record<string, unknown>, known: readonly string[], at: string): string[] {
	return Object.keys(obj)
		.filter((k) => !known.includes(k))
		.map((k) => `${at}: unknown field "${k}"`);
}

function checkLine(value: unknown, at: string, max: number): string[] {
	if (typeof value !== "string" || value.trim() === "")
		return [`${at}: must be a non-empty string`];
	if (/[\r\n]/.test(value)) return [`${at}: must be one line`];
	if (value.length > max) return [`${at}: longer than ${max} characters`];
	return [];
}

function checkFinding(raw: unknown, at: string): string[] {
	if (!isRecord(raw)) return [`${at}: must be an object`];
	const errors = unknownKeys(raw, FINDING_KEYS, at);
	const enums: [string, readonly string[]][] = [
		["criterion", CRITERIA],
		["severity", SEVERITIES],
		["origin", ORIGINS],
		["page", [...PAGE_IDS, SHELL_PAGE]],
		["viewport", [...VIEWPORT_NAMES, BOTH]],
		["theme", [...THEMES, BOTH]],
	];
	for (const [key, allowed] of enums) {
		if (!oneOf(raw[key], allowed)) {
			errors.push(`${at}.${key}: must be one of ${allowed.join(", ")}`);
		}
	}
	for (const key of ["evidence", "issue", "fix"] as const) {
		errors.push(...checkLine(raw[key], `${at}.${key}`, MAX_LINE));
	}
	return errors;
}

function checkStringList(value: unknown, at: string, allowed: readonly string[]): string[] {
	if (!Array.isArray(value)) return [`${at}: must be an array`];
	const bad = value.filter((v) => !oneOf(v, allowed));
	return bad.length === 0 ? [] : [`${at}: unknown entries ${bad.map(String).join(", ")}`];
}

/**
 * Each in-scope page needs all four cases reviewed, or an `evidence-complete`
 * finding that says which are missing. Silence about a missing case is invalid.
 */
function checkCoverage(v: Verdict): string[] {
	const reviewed = new Set(v.casesReviewed);
	const flagged = new Set(
		v.findings.filter((f) => f.criterion === "evidence-complete").map((f) => f.page),
	);
	return v.pagesInScope
		.filter((page) => !flagged.has(page))
		.flatMap((page) => caseNames(page).filter((c) => !reviewed.has(c)))
		.map((c) => `casesReviewed: missing ${c} with no evidence-complete finding`);
}

function checkHeader(raw: Record<string, unknown>): string[] {
	const errors: string[] = [];
	if (raw.schema !== VERDICT_SCHEMA) errors.push(`schema: must be "${VERDICT_SCHEMA}"`);
	if (raw.rubric !== RUBRIC_VERSION) errors.push(`rubric: must be ${RUBRIC_VERSION}`);
	if (typeof raw.headSha !== "string" || !SHA.test(raw.headSha)) {
		errors.push("headSha: must be a lowercase hex commit sha");
	}
	if (!oneOf(raw.verdict, ["pass", "fail"])) errors.push(`verdict: must be "pass" or "fail"`);
	errors.push(...checkStringList(raw.pagesInScope, "pagesInScope", PAGE_IDS));
	if (Array.isArray(raw.pagesInScope) && raw.pagesInScope.length === 0) {
		errors.push("pagesInScope: must name at least one page");
	}
	errors.push(...checkStringList(raw.casesReviewed, "casesReviewed", PAGE_IDS.flatMap(caseNames)));
	errors.push(...checkLine(raw.summary, "summary", MAX_SUMMARY));
	return errors;
}

/** Validate a parsed verdict document and apply the pass rule. */
export function parseVerdict(raw: unknown): ParseResult {
	if (!isRecord(raw)) return { ok: false, errors: ["verdict: must be a JSON object"] };
	const errors = [...unknownKeys(raw, TOP_KEYS, "verdict"), ...checkHeader(raw)];
	if (!Array.isArray(raw.findings)) {
		errors.push("findings: must be an array");
	} else {
		raw.findings.forEach((f, i) => {
			errors.push(...checkFinding(f, `findings[${i}]`));
		});
	}
	if (errors.length > 0) return { ok: false, errors };

	const value = raw as unknown as Verdict;
	const coverage = checkCoverage(value);
	if (coverage.length > 0) return { ok: false, errors: coverage };
	const decision = decide(value.findings);
	if (decision.verdict !== value.verdict) {
		return {
			ok: false,
			errors: [`verdict: says "${value.verdict}" but the findings decide "${decision.verdict}"`],
		};
	}
	return { ok: true, value: { ...value, findings: rankFindings(value.findings) }, decision };
}

/** Cross-check the verdict against the ui-visual artifact's `ci-meta.json`. */
export function checkCiMeta(verdict: Verdict, ciMeta: unknown): string[] {
	if (!isRecord(ciMeta)) return ["ci-meta: must be a JSON object"];
	if (ciMeta.headSha !== verdict.headSha) {
		return [`headSha: verdict reviewed ${verdict.headSha}, artifact is ${String(ciMeta.headSha)}`];
	}
	return [];
}

export interface CliOutcome {
	readonly code: 0 | 1 | 2;
	readonly report: {
		readonly ok: boolean;
		readonly verdict: "pass" | "fail";
		readonly counts: Counts | null;
		readonly errors: readonly string[];
	};
}

function readJson(path: string, read: (p: string) => string): unknown {
	return JSON.parse(read(path));
}

/** The CLI, with file reads injected so tests stay pure. */
export function runCli(argv: readonly string[], read: (p: string) => string): CliOutcome {
	const invalid = (errors: string[]): CliOutcome => ({
		code: 2,
		report: { ok: false, verdict: "fail", counts: null, errors },
	});
	const metaAt = argv.indexOf("--ci-meta");
	const metaPath = metaAt >= 0 ? argv[metaAt + 1] : undefined;
	const metaValueAt = metaAt >= 0 ? metaAt + 1 : -1;
	const verdictPath = argv.find((a, i) => !a.startsWith("--") && i !== metaValueAt);
	if (verdictPath === undefined || (metaAt >= 0 && metaPath === undefined)) {
		return invalid(["usage: verdict.ts <verdict.json> [--ci-meta <ci-meta.json>]"]);
	}
	let parsed: ParseResult;
	let meta: unknown;
	try {
		parsed = parseVerdict(readJson(verdictPath, read));
		meta = metaPath === undefined ? undefined : readJson(metaPath, read);
	} catch (err) {
		return invalid([err instanceof Error ? err.message : String(err)]);
	}
	if (!parsed.ok) return invalid([...parsed.errors]);
	const metaErrors = meta === undefined ? [] : checkCiMeta(parsed.value, meta);
	if (metaErrors.length > 0) return invalid(metaErrors);
	const { verdict, counts } = parsed.decision;
	return { code: verdict === "pass" ? 0 : 1, report: { ok: true, verdict, counts, errors: [] } };
}

if (import.meta.main) {
	const outcome = runCli(process.argv.slice(2), (p) => readFileSync(p, "utf8"));
	console.log(JSON.stringify(outcome.report));
	process.exit(outcome.code);
}
