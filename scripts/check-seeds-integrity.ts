#!/usr/bin/env bun
/**
 * Seeds tracker integrity guard (warren-a71f).
 *
 * `.seeds/issues.jsonl` is the project's issue queue: one JSON object per
 * line, keyed by `id`. Two corruption shapes survive normal git workflows:
 *
 *   1. The same seed id appearing on more than one row. A git auto-merge of
 *      two branches that both appended to the file unions the rows instead
 *      of conflict-flagging them, so a stale copy of an issue rides
 *      alongside its updated twin.
 *   2. CONTRADICTORY duplicate rows for one id — the sharpest sub-case of
 *      (1): one row says `"status":"open"`, the other `"status":"closed"`
 *      (or one carries `closedAt` and the other doesn't). Downstream tooling
 *      then disagrees with itself about the same issue depending on which
 *      row it reads first.
 *
 * Both fail this guard with a `file:line` message. A clean file exits 0.
 * Blank lines are skipped; a line that does not parse as a JSON object with
 * a string `id` also fails — a truncated write is corruption too.
 *
 * Chained into `bun run lint` (alongside check-layers.ts,
 * check-version-sync.ts, check-wire-types.ts and check-prose.ts) rather
 * than registered as its own gate: `scripts/check-all.ts` is byte-identical
 * to the l5-toolkit template and its gate vocabulary is frozen, so a
 * repo-specific assertion folds into an existing gate. Also runnable
 * directly: `bun run check:seeds-integrity`.
 *
 * Scope note: this guard only DETECTS corruption after the fact. The wider
 * problem of serializing concurrent seeds writes across parallel warren
 * runs (so the corruption never lands) is tracked in warren-f6b5.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The one queue, repo-relative POSIX. */
export const ISSUES_FILE = ".seeds/issues.jsonl";

/**
 * When set, `main` reads the queue text from stdin instead of the on-disk
 * file. Used by the pre-push hook (warren-53c0) so the gate scans the blob
 * at the pushed tip rather than a dirty or divergent worktree.
 */
const STDIN_FLAG = "--stdin";

export type ViolationKind = "duplicate-id" | "contradiction" | "invalid-json";

export interface Violation {
	readonly file: string;
	readonly line: number;
	readonly kind: ViolationKind;
	readonly message: string;
}

interface Row {
	readonly line: number;
	readonly id: string;
	readonly status: string | undefined;
	readonly closed: boolean;
}

/**
 * Parse one line into a Row. Returns a Violation instead when the line is
 * not a JSON object carrying a string `id`.
 */
function parseRow(file: string, line: number, text: string): Row | Violation {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("not a JSON object");
		}
		const id = (parsed as { id?: unknown }).id;
		if (typeof id !== "string" || id.length === 0) {
			throw new Error('missing string "id"');
		}
		const status = (parsed as { status?: unknown }).status;
		const closedAt = (parsed as { closedAt?: unknown }).closedAt;
		return {
			line,
			id,
			status: typeof status === "string" ? status : undefined,
			closed: closedAt !== undefined && closedAt !== null,
		};
	} catch (err) {
		return {
			file,
			line,
			kind: "invalid-json",
			message: `does not parse as a seeds issue row (${(err as Error).message})`,
		};
	}
}

/**
 * True when two rows for the same id disagree about the issue's outcome:
 * different `status`, or one carries `closedAt` and the other doesn't.
 */
export function contradicts(a: Row, b: Row): boolean {
	if (a.status !== undefined && b.status !== undefined && a.status !== b.status) return true;
	return a.closed !== b.closed;
}

/** The Violation a duplicate row produces: contradiction if it disagrees. */
function duplicateViolation(file: string, first: Row, row: Row): Violation {
	if (contradicts(first, row)) {
		return {
			file,
			line: row.line,
			kind: "contradiction",
			message:
				`contradicts line ${first.line} for id "${row.id}" ` +
				`(status ${first.status ?? "?"} vs ${row.status ?? "?"}) — ` +
				"keep one row and delete the other",
		};
	}
	return {
		file,
		line: row.line,
		kind: "duplicate-id",
		message: `duplicate row for id "${row.id}" (first seen at line ${first.line}) — keep one`,
	};
}

/** Duplicate-id violations across every id that appears more than once. */
function duplicateViolations(file: string, byId: ReadonlyMap<string, Row[]>): Violation[] {
	const violations: Violation[] = [];
	for (const rows of byId.values()) {
		const first = rows[0];
		if (first === undefined) continue;
		for (const row of rows.slice(1)) {
			violations.push(duplicateViolation(file, first, row));
		}
	}
	return violations;
}

/** Scan issues.jsonl text for duplicate ids, contradictions and bad rows. */
export function scanText(file: string, text: string): Violation[] {
	const violations: Violation[] = [];
	const byId = new Map<string, Row[]>();
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		if (raw.trim() === "") continue;
		const parsed = parseRow(file, i + 1, raw);
		if ("kind" in parsed) {
			violations.push(parsed);
			continue;
		}
		const rows = byId.get(parsed.id) ?? [];
		rows.push(parsed);
		byId.set(parsed.id, rows);
	}
	return [...violations, ...duplicateViolations(file, byId)];
}

function readQueueText(): string {
	if (process.argv.includes(STDIN_FLAG)) {
		return readFileSync(0, "utf8");
	}
	return readFileSync(resolve(REPO_ROOT, ISSUES_FILE), "utf8");
}

function main(): void {
	const text = readQueueText();
	const violations = scanText(ISSUES_FILE, text);
	if (violations.length === 0) {
		const rows = text.split("\n").filter((l) => l.trim() !== "").length;
		console.log(`check:seeds-integrity — ok (${rows} rows, unique ids, no contradictions)`);
		return;
	}
	console.error(`check:seeds-integrity — ${violations.length} problem(s) in ${ISSUES_FILE}:\n`);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line} — ${v.message}`);
	}
	console.error(
		"\nDuplicate and contradictory rows usually survive a git auto-merge of two\n" +
			"branches that both appended to the queue. Resolve by hand: keep the row\n" +
			"that reflects the tracker's real state and delete the twin.",
	);
	process.exit(1);
}

if (import.meta.main) main();
