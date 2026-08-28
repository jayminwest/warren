#!/usr/bin/env bun
/**
 * Prose guard — ASD-STE100 Simplified Technical English, machine-checkable subset.
 *
 * Walks the human-authored markdown listed in `scripts/prose-budgets.json` and
 * counts violations of the mechanical STE rules: sentence length, passive
 * voice, `-ing` main verbs, nominalizations, phrasal verbs, noun stacks over
 * three words, semicolons, clause dashes, contractions, Latin abbreviations,
 * marketing adjectives, and the substitution list.
 *
 * Budget semantics mirror `check-file-sizes.ts`:
 *
 *   - Files NOT listed in `budgets` must have ≤ `threshold` violations.
 *   - Files listed in `budgets` must be ≤ their listed count. That count is a
 *     frozen ceiling (the file's violation count when it was grandfathered
 *     in) — the ratchet only goes down.
 *
 * To lower a budget, clean the prose then lower the number (or delete the
 * entry once it reaches `threshold`). Do NOT raise a number to make the gate
 * pass — that defeats the guard.
 *
 * This enforces the FORM of STE. The judgment rules of the standard (is this
 * the right technical noun? does the sentence mean what the writer intended?)
 * need a human and are deliberately out of scope.
 *
 * Usage:
 *   bun run scripts/check-prose.ts             # gate
 *   bun run scripts/check-prose.ts --report    # per-file detail, never fails
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	ADJECTIVAL,
	BE,
	CONTRACTIONS,
	DETERMINERS,
	ING_NOT_VERB,
	IRREGULAR_PP,
	LATIN,
	MARKETING,
	PHRASAL,
	STOPWORDS,
	SUBSTITUTE,
	VERBISH,
} from "./prose-rules.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUDGETS_PATH = resolve(REPO_ROOT, "scripts/prose-budgets.json");

type BudgetsFile = {
	threshold: number;
	sentenceWordCap: number;
	files: string[];
	budgets: Record<string, number>;
};

export type Violation = { rule: string; line: number; text: string };
export type FileReport = { path: string; words: number; violations: Violation[] };

/**
 * Rules reported but NOT counted toward the budget.
 *
 * `noun-stack(>3)` (STE Rule 2.1) needs part-of-speech tagging to separate a
 * real multi-word noun from a verb phrase. Measured against warren's docs the
 * determiner-anchored heuristic runs at roughly 50% precision — it correctly
 * catches "per-request pino child logger" but also flags "the single run never
 * crosses workers". That is useful to read and wrong to fail a build on, so it
 * stays advisory until it is backed by a tagger. Rule 2.1 is still enforced by
 * the ste-writing skill, where a human reads the suggestion.
 */
export const ADVISORY_RULES: ReadonlySet<string> = new Set(["noun-stack(>3)"]);

export function countable(violations: Violation[]): Violation[] {
	return violations.filter((v) => !ADVISORY_RULES.has(v.rule));
}

function loadBudgets(): BudgetsFile {
	const raw = JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as Record<string, unknown>;
	const threshold = raw.threshold;
	const cap = raw.sentenceWordCap;
	const files = raw.files;
	const budgets = raw.budgets;
	if (typeof threshold !== "number" || threshold < 0) {
		throw new Error(`${BUDGETS_PATH}: "threshold" must be a non-negative number`);
	}
	if (typeof cap !== "number" || cap <= 0) {
		throw new Error(`${BUDGETS_PATH}: "sentenceWordCap" must be a positive number`);
	}
	if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) {
		throw new Error(`${BUDGETS_PATH}: "files" must be an array of paths`);
	}
	if (budgets === null || typeof budgets !== "object" || Array.isArray(budgets)) {
		throw new Error(`${BUDGETS_PATH}: "budgets" must be an object`);
	}
	const normalized: Record<string, number> = {};
	for (const [path, value] of Object.entries(budgets)) {
		if (typeof value !== "number" || value < 0) {
			throw new Error(`${BUDGETS_PATH}: budgets["${path}"] must be a non-negative number`);
		}
		normalized[path] = value;
	}
	return { threshold, sentenceWordCap: cap, files: files as string[], budgets: normalized };
}

/**
 * Reduce markdown to prose lines, keeping 1-based source line numbers.
 * Drops fenced code, inline code, frontmatter, tables, headings, HTML, and
 * link targets (link text survives).
 */
/** Non-prose markdown lines: headings, table rows, HTML, rules, indented code. */
function isNonProse(raw: string, trimmed: string): boolean {
	return (
		trimmed === "" ||
		trimmed.startsWith("#") ||
		trimmed.startsWith("|") ||
		trimmed.startsWith("<") ||
		/^\s{4,}\S/.test(raw) ||
		/^[-=]{3,}$/.test(trimmed)
	);
}

/** Strip inline markdown so only the sentence text remains. */
function stripInline(trimmed: string): string {
	return trimmed
		.replace(/`[^`]*`/g, " CODE ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, " URL ")
		.replace(/^\s*>\s?/, "")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
		.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Track the two markdown block states whose contents are never prose:
 * YAML frontmatter and fenced code. Returns true while inside either.
 */
function makeBlockSkipper(): (index: number, trimmed: string) => boolean {
	let inFence = false;
	let inFrontmatter = false;

	return (index, trimmed) => {
		if (index === 0 && trimmed === "---") {
			inFrontmatter = true;
			return true;
		}
		if (inFrontmatter) {
			if (trimmed === "---") inFrontmatter = false;
			return true;
		}
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = !inFence;
			return true;
		}
		return inFence;
	};
}

export function proseLines(markdown: string): { line: number; text: string; isList: boolean }[] {
	const out: { line: number; text: string; isList: boolean }[] = [];
	const lines = markdown.split("\n");
	const inBlock = makeBlockSkipper();

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const trimmed = raw.trim();
		if (inBlock(i, trimmed) || isNonProse(raw, trimmed)) continue;

		const text = stripInline(trimmed);
		if (text === "") continue;

		out.push({ line: i + 1, text, isList: /^(?:[-*+]|\d+[.)])\s+/.test(trimmed) });
	}
	return out;
}

export function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?:])\s+(?=[A-Z0-9"'(-])/)
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

export function wordCount(sentence: string): number {
	return (sentence.match(/[A-Za-z0-9][A-Za-z0-9'\-/]*/g) ?? []).length;
}

function pushPhraseHits(
	violations: Violation[],
	rule: string,
	line: number,
	haystack: string,
	needles: readonly string[],
): void {
	const low = haystack.toLowerCase();
	for (const needle of needles) {
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "g");
		for (const m of low.matchAll(re)) {
			violations.push({ rule, line, text: haystack.slice(m.index, m.index + needle.length + 12) });
		}
	}
}

/**
 * Flag noun stacks over three words (STE Rule 2.1).
 *
 * A stack is only counted when it is anchored by a determiner — "the <w> <w>
 * <w> <w>" — which is the shape of a real multi-word noun. Without the anchor
 * the heuristic cannot tell a noun stack from a verb phrase, so unanchored
 * runs are left alone. This trades recall for precision on purpose: a gate
 * that cries wolf gets switched off.
 */
function checkNounStacks(violations: Violation[], line: number, sentence: string): void {
	// Punctuation always ends a noun run — a comma or colon is a hard boundary
	// between phrases, so scan each punctuation-delimited segment separately.
	for (const segment of sentence.split(/[^A-Za-z0-9'\s-]+/)) {
		const tokens = segment.match(/[A-Za-z][A-Za-z-]*/g) ?? [];
		let run: string[] = [];
		let anchored = false;

		const flush = (): void => {
			if (anchored && run.length >= 4) {
				violations.push({ rule: "noun-stack(>3)", line, text: run.join(" ") });
			}
			run = [];
			anchored = false;
		};

		for (const token of tokens) {
			const lower = token.toLowerCase();
			if (DETERMINERS.has(lower)) {
				flush();
				anchored = true;
				continue;
			}
			const isStackMember =
				!STOPWORDS.has(lower) &&
				token.length >= 3 &&
				/^[a-z][a-z-]*$/.test(token) &&
				!VERBISH.test(lower);
			if (isStackMember) {
				run.push(token);
				continue;
			}
			flush();
		}
		flush();
	}
}

/**
 * Clause dashes: an em dash anywhere, or an en dash / double hyphen standing
 * alone between spaces. A dash splices two thoughts into one sentence. STE
 * wants the rewrite: two sentences, or a colon. Hyphenated compounds
 * (kebab-case) and unspaced ranges (1–5) do not match.
 */
const DASH_RE = /—|(?<=\s)(?:--|–)(?=\s)/g;

const PASSIVE_RE = new RegExp(`\\b(?:${BE})\\s+(\\w+ed|${IRREGULAR_PP})\\b(\\s+by\\b)?`, "gi");
const ING_RE = new RegExp(`\\b(?:${BE})\\s+(\\w+ing)\\b`, "gi");
const NOMINAL_RE =
	/\b(?:perform(?:s|ed)?|conduct(?:s|ed)?|execute(?:s|d)?|carry out|carries out|make use of)\b/gi;
const NOMINAL_OF_RE = /\b\w{4,}(?:tion|ment|ance|ence)\s+of\b/gi;

/** Verb-form and word-choice rules that apply to a whole prose line. */
function checkLineRules(violations: Violation[], line: number, text: string): void {
	for (const m of text.matchAll(PASSIVE_RE)) {
		const isAdjectival = ADJECTIVAL.has((m[1] ?? "").toLowerCase());
		if (isAdjectival && m[2] === undefined) continue;
		violations.push({ rule: "passive-voice", line, text: m[0] });
	}
	for (const m of text.matchAll(ING_RE)) {
		if (ING_NOT_VERB.has((m[1] ?? "").toLowerCase())) continue;
		violations.push({ rule: "ing-main-verb", line, text: m[0] });
	}
	for (const m of text.matchAll(NOMINAL_RE)) {
		violations.push({ rule: "nominalization", line, text: m[0] });
	}
	for (const m of text.matchAll(NOMINAL_OF_RE)) {
		violations.push({ rule: "nominalization", line, text: m[0] });
	}
	for (const m of text.matchAll(CONTRACTIONS)) {
		violations.push({ rule: "contraction", line, text: m[0] });
	}
	for (let idx = text.indexOf(";"); idx !== -1; idx = text.indexOf(";", idx + 1)) {
		violations.push({ rule: "semicolon", line, text: text.slice(Math.max(0, idx - 20), idx + 1) });
	}
	for (const m of text.matchAll(DASH_RE)) {
		const idx = m.index ?? 0;
		violations.push({ rule: "dash", line, text: text.slice(Math.max(0, idx - 20), idx + 2) });
	}
	pushPhraseHits(violations, "latin-abbreviation", line, text, LATIN);
	pushPhraseHits(violations, "phrasal-verb", line, text, PHRASAL);
	pushPhraseHits(violations, "substitute-word", line, text, SUBSTITUTE);
	pushPhraseHits(violations, "marketing-adjective", line, text, MARKETING);
}

/** Sentence-length and noun-stack rules. Returns the line's word count. */
function checkSentenceRules(
	violations: Violation[],
	line: number,
	sentences: string[],
	cap: number,
): number {
	let words = 0;
	for (const sentence of sentences) {
		const wc = wordCount(sentence);
		words += wc;
		if (wc > cap) {
			violations.push({ rule: `long-sentence(>${cap}w)`, line, text: `${wc} words` });
		}
		checkNounStacks(violations, line, sentence);
	}
	return words;
}

/**
 * Track paragraphs across prose lines and flag any over six sentences.
 *
 * Consecutive non-list lines form a paragraph. Vertical lists are what STE
 * Rule 4.3 asks for, so list items never count toward the ceiling.
 */
function makeParagraphTracker(violations: Violation[]): {
	advance: (line: number, isList: boolean, sentences: number) => void;
	finish: () => void;
} {
	let sentenceCount = 0;
	let start = 0;
	let previousLine = -10;

	const flush = (): void => {
		if (sentenceCount > 6) {
			violations.push({
				rule: "long-paragraph(>6s)",
				line: start,
				text: `${sentenceCount} sentences`,
			});
		}
		sentenceCount = 0;
	};

	return {
		advance(line, isList, sentences) {
			if (line !== previousLine + 1 || isList) {
				flush();
				start = line;
			}
			previousLine = line;
			if (!isList) sentenceCount += sentences;
		},
		finish: flush,
	};
}

export function lint(markdown: string, sentenceWordCap: number): FileReport {
	const violations: Violation[] = [];
	const paragraphs = makeParagraphTracker(violations);
	let words = 0;

	for (const { line, text, isList } of proseLines(markdown)) {
		const sentences = splitSentences(text);
		paragraphs.advance(line, isList, sentences.length);
		words += checkSentenceRules(violations, line, sentences, sentenceWordCap);
		checkLineRules(violations, line, text);
	}
	paragraphs.finish();

	return { path: "", words, violations };
}

export function scan(): { reports: FileReport[]; missing: string[]; stale: string[] } {
	const { sentenceWordCap, files, budgets } = loadBudgets();
	const reports: FileReport[] = [];
	const missing: string[] = [];

	for (const rel of files) {
		const abs = resolve(REPO_ROOT, rel);
		if (!existsSync(abs)) {
			missing.push(rel);
			continue;
		}
		const report = lint(readFileSync(abs, "utf8"), sentenceWordCap);
		report.path = rel;
		reports.push(report);
	}

	const tracked = new Set(files);
	const stale = Object.keys(budgets).filter((p) => !tracked.has(p));
	return { reports, missing, stale };
}

function summarize(violations: Violation[]): string {
	const counts = new Map<string, number>();
	for (const v of violations) counts.set(v.rule, (counts.get(v.rule) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([rule, n]) => `${rule}=${n}`)
		.join(" ");
}

function printReport(reports: FileReport[]): void {
	for (const r of reports) {
		const counted = countable(r.violations);
		const per1k = r.words === 0 ? 0 : (counted.length * 1000) / r.words;
		console.log(
			`${r.path.padEnd(42)} words=${String(r.words).padStart(6)} ` +
				`counted=${String(counted.length).padStart(4)} ` +
				`per1kw=${per1k.toFixed(1).padStart(6)}`,
		);
		if (counted.length > 0) console.log(`  ${summarize(counted)}`);
		const advisory = r.violations.filter((v) => ADVISORY_RULES.has(v.rule));
		if (advisory.length > 0) console.log(`  advisory: ${summarize(advisory)}`);
	}
}

function overBudget(reports: FileReport[], budgets: Record<string, number>, fallback: number) {
	const failures: string[] = [];
	for (const r of reports) {
		const budget = budgets[r.path] ?? fallback;
		const counted = countable(r.violations);
		if (counted.length > budget) {
			failures.push(
				`  ${r.path}: ${counted.length} violations > budget ${budget}\n` +
					`      ${summarize(counted)}`,
			);
		}
	}
	return failures;
}

function reportList(header: string, entries: string[], hint?: string): boolean {
	if (entries.length === 0) return false;
	console.error(header);
	for (const e of entries) console.error(`  - ${e}`);
	if (hint !== undefined) console.error(hint);
	console.error("");
	return true;
}

function main(): void {
	const { threshold, budgets } = loadBudgets();
	const { reports, missing, stale } = scan();

	if (process.argv.includes("--report")) {
		printReport(reports);
		return;
	}

	let failed = reportList("scripts/prose-budgets.json lists files that do not exist:", missing);
	failed =
		reportList(
			"scripts/prose-budgets.json has budgets for untracked files:",
			stale,
			"Remove these entries to keep the budget honest.",
		) || failed;

	const failures = overBudget(reports, budgets, threshold);
	if (failures.length > 0) {
		console.error("Prose guard failed (ASD-STE100 mechanical subset):");
		for (const f of failures) console.error(f);
		console.error("");
		console.error("Run `bun run scripts/check-prose.ts --report` for per-file detail.");
		console.error("Fix the prose (use the ste-writing skill). The ratchet only goes down —");
		console.error("do not raise a budget to make this pass.");
		failed = true;
	}
	if (failed) process.exit(1);

	console.log(`Prose guard ok (${reports.length} files).`);
}

if (import.meta.main) main();
