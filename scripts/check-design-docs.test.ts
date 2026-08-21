import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseCatalog, parseMetadata, scan } from "./check-design-docs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

const shippedRecord = [
	"# Example",
	"",
	"**Kind:** contract",
	"**Design state:** approved",
	"**Delivery:** shipped",
	"**Arrived:** 2026-08-20",
	"**Shipped:** v1.0.0",
	"**Current truth:** `src/example.ts`",
	"",
].join("\n");

function catalog(rows: string[]): string {
	return [
		"# Catalog",
		"",
		"<!-- design-catalog:start -->",
		"| Record | Kind | Design state | Delivery | Arrived |",
		"|---|---|---|---|---|",
		...rows,
		"<!-- design-catalog:end -->",
		"",
	].join("\n");
}

function row(file = "example.md", delivery = "shipped"): string {
	return `| [Example](./${file}) | \`contract\` | \`approved\` | \`${delivery}\` | 2026-08-20 |`;
}

function writeFixtureRepo(dir: string, files: Record<string, string>): void {
	for (const [rel, text] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text);
	}
}

function withFixtureRepo(files: Record<string, string>, run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "warren-design-docs-"));
	try {
		writeFixtureRepo(dir, files);
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("parseMetadata", () => {
	test("reads the standard metadata fields", () => {
		const { metadata, duplicates } = parseMetadata(shippedRecord);
		expect(metadata).toEqual({
			kind: "contract",
			designState: "approved",
			delivery: "shipped",
			arrived: "2026-08-20",
			shipped: "v1.0.0",
			currentTruth: "`src/example.ts`",
		});
		expect(duplicates).toEqual([]);
	});
});

describe("parseCatalog", () => {
	test("reads rows only between the catalog markers", () => {
		const parsed = parseCatalog(catalog([row()]));
		expect(parsed.errors).toEqual([]);
		expect(parsed.rows).toEqual([
			{
				file: "example.md",
				kind: "contract",
				designState: "approved",
				delivery: "shipped",
				arrived: "2026-08-20",
				line: 6,
			},
		]);
	});

	test("refuses malformed rows instead of silently skipping them", () => {
		const parsed = parseCatalog(catalog(["| malformed | row |"]));
		expect(parsed.errors).toEqual(["line 6: malformed catalog row"]);
	});
});

describe("scan", () => {
	test("accepts a complete aligned catalog", () => {
		withFixtureRepo(
			{
				"docs/design/README.md": catalog([row()]),
				"docs/design/example.md": shippedRecord,
			},
			(dir) => expect(scan(dir)).toEqual([]),
		);
	});

	test("reports an uncataloged design record", () => {
		withFixtureRepo(
			{
				"docs/design/README.md": catalog([]),
				"docs/design/example.md": shippedRecord,
			},
			(dir) => {
				expect(scan(dir).map((violation) => violation.message)).toContain(
					"missing from design catalog",
				);
			},
		);
	});

	test("reports metadata drift between the catalog and record", () => {
		withFixtureRepo(
			{
				"docs/design/README.md": catalog([row("example.md", "unscheduled")]),
				"docs/design/example.md": shippedRecord,
			},
			(dir) => {
				expect(scan(dir).map((violation) => violation.message)).toContain(
					'example.md Delivery is "unscheduled" here but "shipped" in the record',
				);
			},
		);
	});

	test("requires shipped records to point to current truth", () => {
		const withoutTruth = shippedRecord.replace("**Current truth:** `src/example.ts`\n", "");
		withFixtureRepo(
			{
				"docs/design/README.md": catalog([row()]),
				"docs/design/example.md": withoutTruth,
			},
			(dir) => {
				expect(scan(dir).map((violation) => violation.message)).toContain(
					"shipped record lacks **Current truth:**",
				);
			},
		);
	});

	test("requires mixed records to have a scope-status section", () => {
		const mixed = shippedRecord
			.replace("**Delivery:** shipped", "**Delivery:** mixed")
			.replace("**Shipped:** v1.0.0\n", "")
			.replace("**Current truth:** `src/example.ts`\n", "");
		withFixtureRepo(
			{
				"docs/design/README.md": catalog([row("example.md", "mixed")]),
				"docs/design/example.md": mixed,
			},
			(dir) => {
				expect(scan(dir).map((violation) => violation.message)).toContain(
					"mixed record lacks a ## Scope status section",
				);
			},
		);
	});

	test("requires next records to name their roadmap order", () => {
		const next = shippedRecord
			.replace("**Delivery:** shipped", "**Delivery:** next")
			.replace("**Shipped:** v1.0.0\n", "")
			.replace("**Current truth:** `src/example.ts`\n", "");
		withFixtureRepo(
			{
				"docs/design/README.md": catalog([row("example.md", "next")]),
				"docs/design/example.md": next,
			},
			(dir) => {
				expect(scan(dir).map((violation) => violation.message)).toContain(
					"next record needs a positive integer **Roadmap order:**",
				);
			},
		);
	});
});

describe("the real repo", () => {
	test("catalogs every design record with aligned metadata", () => {
		expect(scan(REPO_ROOT)).toEqual([]);
	});
});
