#!/usr/bin/env bun
/**
 * report-test-failures.ts (warren-3144)
 *
 * Parses the JUnit XML emitted by `bun test --reporter=junit` and surfaces
 * failing test names where a truncated CI log hides them:
 *
 *   - one `::error` workflow command per failing test, so each failure shows
 *     up as a GitHub annotation on the run page and in the log, and
 *   - a markdown table appended to $GITHUB_STEP_SUMMARY when set.
 *
 * Dependency-free (regex-based, same approach as report-test-timing.ts) and
 * non-gating: always exits 0, even when the artifact is missing or no
 * failures are present. Failing CI is the test runner's job, not ours.
 *
 * Usage:
 *   bun run scripts/report-test-failures.ts [path/to/junit.xml]
 *
 * Default: path = test-results/junit.xml.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface TestFailure {
	name: string;
	classname: string;
	file: string;
	line: number | undefined;
	message: string;
}

// Tiny attribute extractor — JUnit attributes are plain double-quoted strings,
// no embedded quotes in practice from bun's emitter.
function attr(tag: string, name: string): string | undefined {
	const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
	return m ? m[1] : undefined;
}

export function parseFailures(xml: string): TestFailure[] {
	const failures: TestFailure[] = [];
	// A failing case always has a body (<testcase ...><failure .../></testcase>);
	// self-closing <testcase .../> tags are passes and never match here.
	const caseRe = /<testcase\b[^>]*(?<!\/)>([\s\S]*?)<\/testcase>/g;
	for (const match of xml.matchAll(caseRe)) {
		const tag = match[0];
		const body = match[1] ?? "";
		const failureMatch = body.match(/<failure\b[^>]*>/);
		if (!failureMatch) continue;
		const lineStr = attr(tag, "line");
		const line = lineStr ? Number.parseInt(lineStr, 10) : undefined;
		failures.push({
			name: attr(tag, "name") ?? "",
			classname: attr(tag, "classname") ?? "",
			file: attr(tag, "file") ?? "",
			line: line !== undefined && Number.isFinite(line) ? line : undefined,
			message: attr(failureMatch[0], "message") ?? "",
		});
	}
	return failures;
}

// GitHub workflow commands treat %, \r, \n as command delimiters in messages.
function escapeAnnotation(text: string): string {
	return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function formatAnnotations(failures: TestFailure[]): string {
	return failures
		.map((f) => {
			const location = f.line !== undefined ? ` file=${f.file},line=${f.line}` : "";
			const label = `${f.classname} › ${f.name}`.replace(/\s+›\s*$/, "");
			const detail = f.message ? ` — ${f.message.split("\n")[0]}` : "";
			return `::error${location}::${escapeAnnotation(`${label}${detail}`)}`;
		})
		.join("\n");
}

export function formatSummary(failures: TestFailure[]): string {
	const lines: string[] = [];
	lines.push("## Failing tests");
	lines.push("");
	lines.push(`**${failures.length}** test(s) failed:`);
	lines.push("");
	lines.push("| Test | File |");
	lines.push("| --- | --- |");
	for (const f of failures) {
		const name = `${f.classname} › ${f.name}`.replace(/\|/g, "\\|");
		const location = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
		lines.push(`| ${name} | \`${location}\` |`);
	}
	lines.push("");
	return lines.join("\n");
}

async function main(): Promise<void> {
	const path = process.argv[2] ?? "test-results/junit.xml";
	if (!existsSync(path)) {
		console.error(
			`report-test-failures: ${path} not found — did 'bun test --reporter=junit --reporter-outfile=${path}' run?`,
		);
		// Don't fail CI just because the artifact is missing; the test job itself
		// will have failed first.
		process.exit(0);
	}
	const failures = parseFailures(readFileSync(path, "utf8"));
	if (failures.length === 0) {
		console.log("report-test-failures: no failing tests found.");
		return;
	}
	console.log(formatAnnotations(failures));
	const summary = formatSummary(failures);
	console.log(`\n${summary}`);
	const stepSummary = process.env.GITHUB_STEP_SUMMARY;
	if (stepSummary) {
		appendFileSync(stepSummary, `${summary}\n`);
	}
}

if (import.meta.main) {
	await main();
}
