/**
 * Pure accessibility judgement for the ui-visual harness (warren-b629).
 * The browser spec (`a11y.pw.ts`) runs axe-core on every manifest case and
 * hands the raw violations here; filtering, allowlist matching, and the
 * report format all run under `bun test` with no browser.
 *
 * Only `serious` and `critical` impacts fail a case. Today's violations
 * are grandfathered in `a11y-allowlist.json`, keyed by page + rule id with
 * a tracker id each. A listed violation that stops reproducing fails the
 * run, so the list only shrinks: delete the entry in the PR that fixes it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PageCase } from "./pages.ts";

/** axe rule tags the pass runs: WCAG 2.0 level A and AA. */
export const AXE_TAGS = ["wcag2a", "wcag2aa"] as const;

/** Impacts that fail a case; `minor` and `moderate` are reported by axe but ignored here. */
export const BLOCKING_IMPACTS = ["serious", "critical"] as const;
export type BlockingImpact = (typeof BLOCKING_IMPACTS)[number];

/** Cap on selectors listed per violation in a failure message. */
const MAX_TARGETS = 8;

/** The slice of an axe-core `Result` this module reads (structural, no axe import). */
export interface AxeResultLike {
	readonly id: string;
	readonly impact?: string | null;
	readonly help: string;
	readonly helpUrl: string;
	readonly nodes: readonly { readonly target: readonly unknown[] }[];
}

/** One blocking violation on one case, flattened for reporting. */
export interface A11yViolation {
	readonly rule: string;
	readonly impact: BlockingImpact;
	readonly help: string;
	readonly helpUrl: string;
	/** CSS selectors of the offending nodes (shadow/iframe paths joined with " >>> "). */
	readonly targets: readonly string[];
}

function isBlocking(impact: string | null | undefined): impact is BlockingImpact {
	return (BLOCKING_IMPACTS as readonly (string | null | undefined)[]).includes(impact);
}

/** Keep only serious and critical violations, flattened for the report. */
export function blockingViolations(results: readonly AxeResultLike[]): A11yViolation[] {
	return results.flatMap((r) =>
		isBlocking(r.impact)
			? [
					{
						rule: r.id,
						impact: r.impact,
						help: r.help,
						helpUrl: r.helpUrl,
						targets: r.nodes.map((n) => n.target.map(String).join(" >>> ")),
					},
				]
			: [],
	);
}

/** A grandfathered violation: tolerated on its page until its tracked fix lands. */
export interface A11yAllowEntry {
	/** Manifest page id (`PAGES[].id`). */
	readonly page: string;
	/** axe rule id, e.g. `color-contrast`. */
	readonly rule: string;
	/** Omitted = every viewport / theme. */
	readonly viewport?: string;
	readonly theme?: string;
	/** The seeds issue tracking the fix, e.g. "warren-1234". */
	readonly seed: string;
	readonly reason: string;
}

export const ALLOWLIST_PATH = join(import.meta.dirname, "a11y-allowlist.json");

const SEED_ID = /^(warren|pl)-[0-9a-f]{4}$/;

function optionalString(
	o: Record<string, unknown>,
	key: string,
	where: string,
): string | undefined {
	const v = o[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string" || v === "") throw new Error(`${where}: "${key}" must be a string`);
	return v;
}

function requiredString(o: Record<string, unknown>, key: string, where: string): string {
	const v = optionalString(o, key, where);
	if (v === undefined) throw new Error(`${where}: "${key}" is required`);
	return v;
}

/** Validate the allowlist file's parsed JSON. Throws with the offending index. */
export function parseAllowlist(raw: unknown): A11yAllowEntry[] {
	const list = (raw as { allowlist?: unknown } | null)?.allowlist;
	if (!Array.isArray(list)) throw new Error('a11y allowlist: "allowlist" must be an array');
	return list.map((item: unknown, i) => {
		const where = `a11y allowlist[${i}]`;
		if (typeof item !== "object" || item === null) throw new Error(`${where}: must be an object`);
		const o = item as Record<string, unknown>;
		const seed = requiredString(o, "seed", where);
		if (!SEED_ID.test(seed)) throw new Error(`${where}: "seed" must look like warren-XXXX`);
		const viewport = optionalString(o, "viewport", where);
		const theme = optionalString(o, "theme", where);
		return {
			page: requiredString(o, "page", where),
			rule: requiredString(o, "rule", where),
			...(viewport === undefined ? {} : { viewport }),
			...(theme === undefined ? {} : { theme }),
			seed,
			reason: requiredString(o, "reason", where),
		};
	});
}

/** Read and validate `a11y-allowlist.json`. */
export function loadAllowlist(path: string = ALLOWLIST_PATH): A11yAllowEntry[] {
	return parseAllowlist(JSON.parse(readFileSync(path, "utf8")));
}

type CaseKey = Pick<PageCase, "page" | "viewport" | "theme">;

function appliesTo(e: A11yAllowEntry, c: CaseKey): boolean {
	return (
		e.page === c.page.id &&
		(e.viewport === undefined || e.viewport === c.viewport) &&
		(e.theme === undefined || e.theme === c.theme)
	);
}

export interface A11yVerdict {
	/** Violations no allowlist entry covers. */
	readonly unexpected: readonly A11yViolation[];
	/** Entries that matched nothing on this case: stale, and must go. */
	readonly stale: readonly A11yAllowEntry[];
	/** Entries that reproduced as expected. */
	readonly tolerated: readonly A11yAllowEntry[];
}

/** Split one case's blocking violations against the allowlist. */
export function reconcileA11y(
	c: CaseKey,
	violations: readonly A11yViolation[],
	allowlist: readonly A11yAllowEntry[],
): A11yVerdict {
	const applicable = allowlist.filter((e) => appliesTo(e, c));
	const used = new Set<A11yAllowEntry>();
	const unexpected = violations.filter((v) => {
		const entries = applicable.filter((e) => e.rule === v.rule);
		for (const e of entries) used.add(e);
		return entries.length === 0;
	});
	return {
		unexpected,
		stale: applicable.filter((e) => !used.has(e)),
		tolerated: applicable.filter((e) => used.has(e)),
	};
}

/** One violation as report lines: rule, impact, help, URL, then selectors. */
export function formatViolation(v: A11yViolation): string[] {
	const shown = v.targets.slice(0, MAX_TARGETS).map((t) => `    ${t}`);
	const more = v.targets.length - shown.length;
	return [
		`[${v.rule}] ${v.impact}: ${v.help} (${v.targets.length} node${v.targets.length === 1 ? "" : "s"})`,
		`    ${v.helpUrl}`,
		...shown,
		...(more > 0 ? [`    … and ${more} more`] : []),
	];
}

/** The assertion message for a verdict; empty when the case passes. */
export function formatA11yVerdict(caseName: string, v: A11yVerdict): string {
	const lines = v.unexpected.flatMap(formatViolation);
	for (const e of v.stale) {
		lines.push(
			`[${e.rule}] allowlisted violation (${e.seed}) no longer reproduces: ` +
				"delete it from scripts/ui-visual/a11y-allowlist.json",
		);
	}
	return lines.length === 0 ? "" : `${caseName}\n${lines.join("\n")}`;
}
