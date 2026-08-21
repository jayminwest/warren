#!/usr/bin/env bun
/**
 * Design-record catalog guard.
 *
 * `docs/design/README.md` is the complete catalog for the flat, public
 * `docs/design/*.md` namespace. This check prevents a new record from becoming
 * invisible and keeps the catalog's lifecycle claims aligned with each
 * record's standard metadata.
 *
 * Chained into `bun run lint` because Warren's canonical gate vocabulary is
 * frozen. Also runnable directly as `bun run check:design-docs`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const DESIGN_DIR = "docs/design";
export const CATALOG_FILE = `${DESIGN_DIR}/README.md`;
const CATALOG_START = "<!-- design-catalog:start -->";
const CATALOG_END = "<!-- design-catalog:end -->";

export const KINDS = [
	"direction",
	"proposal",
	"pilot",
	"contract",
	"architecture-decision",
	"historical-evidence",
] as const;
export const DESIGN_STATES = ["draft", "proposed", "approved", "superseded", "retired"] as const;
export const DELIVERIES = [
	"unscheduled",
	"now",
	"next",
	"deferred",
	"shipped",
	"mixed",
	"not-in-core",
	"not-applicable",
] as const;

export interface DesignMetadata {
	readonly kind?: string;
	readonly designState?: string;
	readonly delivery?: string;
	readonly arrived?: string;
	readonly shipped?: string;
	readonly currentTruth?: string;
	readonly roadmapOrder?: string;
}

export interface CatalogRow {
	readonly file: string;
	readonly kind: string;
	readonly designState: string;
	readonly delivery: string;
	readonly arrived: string;
	readonly line: number;
}

export interface DesignViolation {
	readonly file: string;
	readonly line?: number;
	readonly message: string;
}

const METADATA_FIELDS: Readonly<Record<string, keyof DesignMetadata>> = {
	Kind: "kind",
	"Design state": "designState",
	Delivery: "delivery",
	Arrived: "arrived",
	Shipped: "shipped",
	"Current truth": "currentTruth",
	"Roadmap order": "roadmapOrder",
};

function isIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** Read the standard bold-label metadata from one design record. */
export function parseMetadata(text: string): {
	metadata: DesignMetadata;
	duplicates: string[];
} {
	const metadata: Record<string, string> = {};
	const duplicates: string[] = [];
	for (const line of text.split("\n")) {
		const found = /^\*\*([^*]+):\*\*\s*(.+?)\s*$/.exec(line);
		if (found?.[1] === undefined || found[2] === undefined) continue;
		const key = METADATA_FIELDS[found[1]];
		if (key === undefined) continue;
		if (metadata[key] !== undefined) duplicates.push(found[1]);
		metadata[key] = found[2];
	}
	return { metadata, duplicates };
}

function catalogBounds(lines: string[]): { start: number; end: number } | string {
	const starts = lines.flatMap((line, i) => (line.trim() === CATALOG_START ? [i] : []));
	const ends = lines.flatMap((line, i) => (line.trim() === CATALOG_END ? [i] : []));
	if (starts.length !== 1 || ends.length !== 1) {
		return "catalog must contain exactly one start marker and one end marker";
	}
	const start = starts[0] ?? -1;
	const end = ends[0] ?? -1;
	if (start >= end) return "catalog markers are out of order";
	return { start, end };
}

function isCatalogScaffold(line: string): boolean {
	return line.trim() === "" || line.startsWith("|---") || line.startsWith("| Record |");
}

/** Parse only the authoritative table between the catalog markers. */
export function parseCatalog(text: string): { rows: CatalogRow[]; errors: string[] } {
	const lines = text.split("\n");
	const bounds = catalogBounds(lines);
	if (typeof bounds === "string") return { rows: [], errors: [bounds] };

	const rows: CatalogRow[] = [];
	const errors: string[] = [];
	const rowPattern =
		/^\| \[[^\]]+\]\(\.\/([a-z0-9][a-z0-9.-]*\.md)\) \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| (\d{4}-\d{2}-\d{2}) \|$/;
	for (let i = bounds.start + 1; i < bounds.end; i++) {
		const line = lines[i] ?? "";
		if (isCatalogScaffold(line)) continue;
		const found = rowPattern.exec(line);
		if (found === null) {
			errors.push(`line ${i + 1}: malformed catalog row`);
			continue;
		}
		rows.push({
			file: found[1] ?? "",
			kind: found[2] ?? "",
			designState: found[3] ?? "",
			delivery: found[4] ?? "",
			arrived: found[5] ?? "",
			line: i + 1,
		});
	}
	return { rows, errors };
}

function pushMissingMetadata(
	violations: DesignViolation[],
	file: string,
	metadata: DesignMetadata,
): void {
	for (const [label, key] of [
		["Kind", "kind"],
		["Design state", "designState"],
		["Delivery", "delivery"],
		["Arrived", "arrived"],
	] as const) {
		if (metadata[key] === undefined)
			violations.push({ file, message: `missing **${label}:** metadata` });
	}
}

function validateVocabulary(file: string, metadata: DesignMetadata): DesignViolation[] {
	const violations: DesignViolation[] = [];
	if (metadata.kind !== undefined && !KINDS.includes(metadata.kind as (typeof KINDS)[number])) {
		violations.push({ file, message: `unknown Kind "${metadata.kind}"` });
	}
	if (
		metadata.designState !== undefined &&
		!DESIGN_STATES.includes(metadata.designState as (typeof DESIGN_STATES)[number])
	) {
		violations.push({ file, message: `unknown Design state "${metadata.designState}"` });
	}
	if (
		metadata.delivery !== undefined &&
		!DELIVERIES.includes(metadata.delivery as (typeof DELIVERIES)[number])
	) {
		violations.push({ file, message: `unknown Delivery "${metadata.delivery}"` });
	}
	if (metadata.arrived !== undefined && !isIsoDate(metadata.arrived)) {
		violations.push({
			file,
			message: `Arrived must be a real YYYY-MM-DD date, got "${metadata.arrived}"`,
		});
	}
	return violations;
}

function validateDelivery(file: string, text: string, metadata: DesignMetadata): DesignViolation[] {
	const violations: DesignViolation[] = [];
	if (metadata.delivery === "shipped") {
		if (metadata.shipped === undefined)
			violations.push({ file, message: "shipped record lacks **Shipped:**" });
		if (metadata.currentTruth === undefined) {
			violations.push({ file, message: "shipped record lacks **Current truth:**" });
		}
	}
	if (metadata.delivery === "mixed" && !/^## Scope status\s*$/m.test(text)) {
		violations.push({ file, message: "mixed record lacks a ## Scope status section" });
	}
	if (metadata.delivery === "next") {
		if (metadata.roadmapOrder === undefined || !/^[1-9]\d*$/.test(metadata.roadmapOrder)) {
			violations.push({ file, message: "next record needs a positive integer **Roadmap order:**" });
		}
	} else if (metadata.roadmapOrder !== undefined) {
		violations.push({ file, message: "Roadmap order is only valid when Delivery is next" });
	}
	return violations;
}

function validateMetadata(file: string, text: string, metadata: DesignMetadata): DesignViolation[] {
	const violations: DesignViolation[] = [];
	pushMissingMetadata(violations, file, metadata);
	violations.push(...validateVocabulary(file, metadata));
	violations.push(...validateDelivery(file, text, metadata));
	return violations;
}

function indexRows(rows: CatalogRow[]): Map<string, CatalogRow[]> {
	const rowsByFile = new Map<string, CatalogRow[]>();
	for (const row of rows) {
		const existing = rowsByFile.get(row.file) ?? [];
		existing.push(row);
		rowsByFile.set(row.file, existing);
	}
	return rowsByFile;
}

function catalogAlignment(
	file: string,
	row: CatalogRow,
	metadata: DesignMetadata,
): DesignViolation[] {
	const violations: DesignViolation[] = [];
	for (const [label, catalogValue, recordValue] of [
		["Kind", row.kind, metadata.kind],
		["Design state", row.designState, metadata.designState],
		["Delivery", row.delivery, metadata.delivery],
		["Arrived", row.arrived, metadata.arrived],
	] as const) {
		if (recordValue !== undefined && catalogValue !== recordValue) {
			violations.push({
				file: CATALOG_FILE,
				line: row.line,
				message: `${file} ${label} is "${catalogValue}" here but "${recordValue}" in the record`,
			});
		}
	}
	return violations;
}

function validateRecord(
	designDir: string,
	file: string,
	rowsByFile: ReadonlyMap<string, CatalogRow[]>,
): DesignViolation[] {
	const rel = `${DESIGN_DIR}/${file}`;
	const text = readFileSync(resolve(designDir, file), "utf8");
	const { metadata, duplicates } = parseMetadata(text);
	const violations = duplicates.map((label) => ({
		file: rel,
		message: `duplicate **${label}:** metadata`,
	}));
	violations.push(...validateMetadata(rel, text, metadata));

	const matchingRows = rowsByFile.get(file) ?? [];
	if (matchingRows.length === 0) {
		violations.push({ file: rel, message: "missing from design catalog" });
		return violations;
	}
	if (matchingRows.length > 1) {
		violations.push({
			file: CATALOG_FILE,
			message: `${file} appears ${matchingRows.length} times`,
		});
		return violations;
	}
	const row = matchingRows[0];
	if (row !== undefined) violations.push(...catalogAlignment(file, row, metadata));
	return violations;
}

/** Validate a repository or a synthetic fixture rooted at `repoRoot`. */
export function scan(repoRoot: string = REPO_ROOT): DesignViolation[] {
	const designDir = resolve(repoRoot, DESIGN_DIR);
	const catalogText = readFileSync(resolve(repoRoot, CATALOG_FILE), "utf8");
	const { rows, errors } = parseCatalog(catalogText);
	const violations: DesignViolation[] = errors.map((message) => ({ file: CATALOG_FILE, message }));
	const recordFiles = readdirSync(designDir)
		.filter((file) => file.endsWith(".md") && file !== "README.md")
		.sort();
	const rowsByFile = indexRows(rows);

	for (const row of rows) {
		if (!recordFiles.includes(row.file)) {
			violations.push({
				file: CATALOG_FILE,
				line: row.line,
				message: `catalogs missing file ${row.file}`,
			});
		}
	}
	for (const file of recordFiles) {
		violations.push(...validateRecord(designDir, file, rowsByFile));
	}
	return violations;
}

function main(): void {
	const violations = scan();
	if (violations.length === 0) {
		const count = readdirSync(resolve(REPO_ROOT, DESIGN_DIR)).filter(
			(file) => file.endsWith(".md") && file !== "README.md",
		).length;
		console.log(`check:design-docs — ok (${count} records cataloged)`);
		return;
	}

	console.error(`check:design-docs — ${violations.length} violation(s):\n`);
	for (const violation of violations) {
		const location =
			violation.line === undefined ? violation.file : `${violation.file}:${violation.line}`;
		console.error(`  ${location} — ${violation.message}`);
	}
	console.error(
		"\nKeep docs/design paths flat and stable. Add standard metadata to every record,\n" +
			"then add exactly one matching row to docs/design/README.md. Approval does not\n" +
			"mean roadmap commitment; only ROADMAP.md promotes work into now or next.",
	);
	process.exit(1);
}

if (import.meta.main) main();
