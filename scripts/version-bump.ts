#!/usr/bin/env bun
/**
 * Version bump for warren (warren-16b5, plan pl-b82d step 5).
 *
 * Ported from burrow's `scripts/version-bump.ts` and extended to cover
 * warren's four version sites plus an assistive CHANGELOG draft:
 *
 *   1. `package.json`      — the `"version"` field
 *   2. `src/index.ts`      — `export const VERSION = "X.Y.Z"`
 *   3. `docs/openapi.yaml` — `info.version`, refreshed by re-running
 *                            `bun run gen:openapi` (the generator reads
 *                            the version straight out of package.json,
 *                            so it must run AFTER the rewrite)
 *   4. `README.md`         — the semver in the `## Status` paragraph
 *
 * It also drafts a `[Unreleased]` block into `CHANGELOG.md` from the PR
 * titles in `git log <last-tag>..HEAD`. That draft is **assistive only** —
 * CHANGELOG curation stays human, and nothing in CI gates on it. The
 * block is fenced by HTML comment sentinels so a re-run replaces it
 * instead of stacking duplicates, and so a human can see exactly what to
 * edit down and delete.
 *
 * Usage:
 *   bun run version:bump patch          # 0.10.1 -> 0.10.2
 *   bun run version:bump minor          # 0.10.1 -> 0.11.0
 *   bun run version:bump major          # 0.10.1 -> 1.0.0
 *   bun run version:bump 0.11.0-rc.1    # explicit version
 *
 * Every file is read and rewritten in memory first; the writes happen
 * only once all rewrites (and the openapi regen) can succeed, and any
 * failure restores every file already touched (burrow's rollback
 * pattern, widened from two files to five).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
const INDEX_PATH = resolve(REPO_ROOT, "src/index.ts");
const README_PATH = resolve(REPO_ROOT, "README.md");
const CHANGELOG_PATH = resolve(REPO_ROOT, "CHANGELOG.md");
const OPENAPI_PATH = resolve(REPO_ROOT, "docs/openapi.yaml");

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export const DRAFT_START = "<!-- version-bump:draft -->";
export const DRAFT_END = "<!-- /version-bump:draft -->";

/** Commit subjects that are bookkeeping noise, never changelog material. */
const NOISE_SUBJECT_RES = [
	/^seeds: sync\b/,
	/^mulch: /,
	/^chore\(warren\): /,
	/^chore: release v/,
	/^Merge (branch|pull request|remote-tracking)\b/,
];

/** Bump one level of a plain `X.Y.Z` release version. */
export function bumpSemver(current: string, level: "major" | "minor" | "patch"): string {
	const match = RELEASE_SEMVER_RE.exec(current);
	if (!match) {
		throw new Error(`Cannot ${level}-bump a non-release version: ${current}`);
	}
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (level === "major") return `${major + 1}.0.0`;
	if (level === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

/** Resolve the CLI argument (`major|minor|patch|<explicit>`) to the next version. */
export function resolveNextVersion(arg: string | undefined, current: string): string {
	if (arg === "major" || arg === "minor" || arg === "patch") {
		return bumpSemver(current, arg);
	}
	if (arg !== undefined && SEMVER_RE.test(arg)) {
		if (arg === current) {
			throw new Error(`Version is already ${current} — nothing to bump.`);
		}
		return arg;
	}
	throw new Error(
		`Usage: bun run version:bump <major|minor|patch|X.Y.Z>\n  current version: ${current}`,
	);
}

/** Rewrite the `"version"` field in package.json text. */
export function rewritePackageVersion(text: string, current: string, next: string): string {
	const needle = `"version": "${current}"`;
	if (!text.includes(needle)) {
		throw new Error(`Could not find ${needle} in package.json`);
	}
	return text.replace(needle, `"version": "${next}"`);
}

/** Rewrite the exported `VERSION` constant in src/index.ts text. */
export function rewriteIndexVersion(text: string, current: string, next: string): string {
	const needle = `const VERSION = "${current}"`;
	if (!text.includes(needle)) {
		throw new Error(`Could not find 'const VERSION = "${current}"' in src/index.ts`);
	}
	return text.replace(needle, `const VERSION = "${next}"`);
}

const README_STATUS_VERSION_RE = /`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`/;

export interface ReadmeStatusVersion {
	/** Offset of the opening backtick within the full README text. */
	readonly start: number;
	/** Offset one past the closing backtick. */
	readonly end: number;
	/** The bare semver, backticks stripped. */
	readonly version: string;
}

/**
 * Locate the semver in README's `## Status` paragraph: the first
 * backticked semver after the heading.
 *
 * Matched positionally rather than by the current value, so a README
 * that has already drifted — as it had at warren-16b5, reading `0.9.10`
 * against an actual `0.10.1` — still gets corrected instead of failing
 * the bump.
 *
 * Shared with `scripts/check-version-sync.ts` (warren-0210) so the
 * bumper and the gate can never disagree about where the version lives.
 */
export function locateReadmeStatusVersion(text: string): ReadmeStatusVersion {
	const heading = /^## Status\s*$/m.exec(text);
	if (!heading) {
		throw new Error("Could not find a `## Status` heading in README.md");
	}
	const sectionStart = heading.index + heading[0].length;
	const found = README_STATUS_VERSION_RE.exec(text.slice(sectionStart));
	if (!found) {
		throw new Error("Could not find a backticked semver in README.md's `## Status` section");
	}
	const start = sectionStart + found.index;
	return { start, end: start + found[0].length, version: found[0].slice(1, -1) };
}

/** Rewrite the semver in README's `## Status` paragraph. */
export function rewriteReadmeStatusVersion(text: string, next: string): string {
	const found = locateReadmeStatusVersion(text);
	return `${text.slice(0, found.start)}\`${next}\`${text.slice(found.end)}`;
}

/**
 * Pick changelog-worthy subjects out of `git log --pretty=%s` output.
 *
 * Squash-merged PRs carry a `(#N)` suffix; agent branches land as plain
 * conventional-commit subjects. Both are kept, bookkeeping commits are
 * dropped, and duplicates (a PR landed twice across branches) collapse.
 */
export function parseChangelogEntries(gitLogOutput: string): string[] {
	const seen = new Set<string>();
	const entries: string[] = [];
	for (const raw of gitLogOutput.split("\n")) {
		const subject = raw.trim();
		if (subject.length === 0) continue;
		if (NOISE_SUBJECT_RES.some((re) => re.test(subject))) continue;
		if (seen.has(subject)) continue;
		seen.add(subject);
		entries.push(subject);
	}
	return entries;
}

/** Strip a previously generated draft block (and its trailing blank line). */
function stripExistingDraft(text: string): string {
	const start = text.indexOf(DRAFT_START);
	if (start === -1) return text;
	const end = text.indexOf(DRAFT_END, start);
	if (end === -1) return text;
	const after = end + DRAFT_END.length;
	const before = text.slice(0, start).replace(/\n+$/, "");
	return `${before}\n${text.slice(after).replace(/^\n+/, "\n")}`;
}

/**
 * Insert (or replace) the draft block under `## [Unreleased]`.
 *
 * The heading is created ahead of the newest release section when it is
 * missing. Human-written entries already in the section are preserved —
 * the draft is inserted directly under the heading, above them.
 */
export function draftUnreleasedSection(
	changelogText: string,
	entries: string[],
	range: string,
): string {
	let text = stripExistingDraft(changelogText);

	const headingRe = /^## \[Unreleased\][ \t]*$/m;
	let heading = headingRe.exec(text);
	if (!heading) {
		const firstRelease = /^## \[/m.exec(text);
		if (!firstRelease) {
			throw new Error("CHANGELOG.md has no `## [Unreleased]` heading and no release sections");
		}
		text = `${text.slice(0, firstRelease.index)}## [Unreleased]\n\n${text.slice(firstRelease.index)}`;
		heading = headingRe.exec(text);
		if (!heading)
			throw new Error("Failed to insert an `## [Unreleased]` heading into CHANGELOG.md");
	}

	const body =
		entries.length > 0
			? entries.map((entry) => `- ${entry}`).join("\n")
			: "- _(no commits found in range — nothing to draft)_";
	const block = [
		DRAFT_START,
		"<!--",
		`  DRAFT — generated by \`bun run version:bump\` from \`git log ${range}\``,
		`  (${entries.length} commit${entries.length === 1 ? "" : "s"}, newest first).`,
		"  Assistive only: nothing in CI gates on this. Curate it by hand — regroup the",
		"  entries under `### Added` / `### Changed` / `### Fixed`, drop the noise, then",
		"  delete these two comment markers before cutting the release.",
		"-->",
		body,
		DRAFT_END,
	].join("\n");

	const insertAt = heading.index + heading[0].length;
	return `${text.slice(0, insertAt)}\n\n${block}\n${text.slice(insertAt).replace(/^\n+/, "\n")}`;
}

/** Read `git log <range> --no-merges --pretty=%s`, tolerating a tagless repo. */
function collectEntries(): { entries: string[]; range: string } {
	const described = spawnSync("git", ["describe", "--tags", "--abbrev=0"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	const lastTag = described.status === 0 ? described.stdout.trim() : "";
	const range = lastTag.length > 0 ? `${lastTag}..HEAD` : "HEAD";
	const log = spawnSync("git", ["log", range, "--no-merges", "--pretty=%s"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	if (log.status !== 0) {
		throw new Error(`git log ${range} failed: ${log.stderr.trim()}`);
	}
	return { entries: parseChangelogEntries(log.stdout), range };
}

export interface PendingWrite {
	path: string;
	original: string;
	updated: string;
}

/** Write every pending file, restoring all of them if any single write throws. */
export function commitWrites(writes: PendingWrite[]): void {
	const done: PendingWrite[] = [];
	try {
		for (const write of writes) {
			writeFileSync(write.path, write.updated);
			done.push(write);
		}
	} catch (error) {
		for (const write of done.reverse()) writeFileSync(write.path, write.original);
		throw error;
	}
}

function main(): void {
	const pkgText = readFileSync(PACKAGE_JSON_PATH, "utf8");
	const current = (JSON.parse(pkgText) as { version?: unknown }).version;
	if (typeof current !== "string" || !SEMVER_RE.test(current)) {
		console.error(`Invalid version in package.json: ${String(current)}`);
		process.exit(1);
	}

	let next: string;
	let writes: PendingWrite[];
	try {
		next = resolveNextVersion(process.argv[2], current);
		const indexText = readFileSync(INDEX_PATH, "utf8");
		const readmeText = readFileSync(README_PATH, "utf8");
		const changelogText = readFileSync(CHANGELOG_PATH, "utf8");
		const { entries, range } = collectEntries();
		writes = [
			{
				path: PACKAGE_JSON_PATH,
				original: pkgText,
				updated: rewritePackageVersion(pkgText, current, next),
			},
			{
				path: INDEX_PATH,
				original: indexText,
				updated: rewriteIndexVersion(indexText, current, next),
			},
			{
				path: README_PATH,
				original: readmeText,
				updated: rewriteReadmeStatusVersion(readmeText, next),
			},
			{
				path: CHANGELOG_PATH,
				original: changelogText,
				updated: draftUnreleasedSection(changelogText, entries, range),
			},
		];
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}

	// docs/openapi.yaml is regenerated rather than rewritten, but it still
	// needs an original captured so a failed regen rolls back with the rest.
	const openapiOriginal = readFileSync(OPENAPI_PATH, "utf8");
	commitWrites(writes);

	const regen = spawnSync("bun", ["run", "gen:openapi"], { cwd: REPO_ROOT, encoding: "utf8" });
	if (regen.status !== 0) {
		for (const write of [...writes].reverse()) writeFileSync(write.path, write.original);
		writeFileSync(OPENAPI_PATH, openapiOriginal);
		console.error("gen:openapi failed — rolled back every version site.");
		console.error(regen.stderr.trim() || regen.stdout.trim());
		process.exit(1);
	}

	console.log(`Bumped ${current} → ${next}`);
	console.log("  package.json       version");
	console.log("  src/index.ts       VERSION");
	console.log("  docs/openapi.yaml  info.version (via gen:openapi)");
	console.log("  README.md          ## Status");
	console.log("  CHANGELOG.md       [Unreleased] draft — EDIT THIS BY HAND");
	console.log("");
	console.log("Next steps:");
	console.log("  1. Curate the CHANGELOG draft: regroup under ### Added/Changed/Fixed,");
	console.log(`     rename the heading to [${next}] — YYYY-MM-DD, delete the draft markers`);
	console.log("  2. bun run check:all");
	console.log(`  3. git add -A && git commit -m "chore: release v${next}"`);
	console.log("  4. git push  (on merge to main, .github/workflows/release.yml verifies");
	console.log(`     package.json == src/index.ts, tags v${next}, and cuts the GitHub`);
	console.log("     release from the matching CHANGELOG.md section)");
}

if (import.meta.main) main();
