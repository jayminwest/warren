import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	bumpSemver,
	commitWrites,
	DRAFT_END,
	DRAFT_START,
	draftUnreleasedSection,
	locateReadmeStatusVersion,
	parseChangelogEntries,
	resolveNextVersion,
	rewriteIndexVersion,
	rewritePackageVersion,
	rewriteReadmeStatusVersion,
} from "./version-bump.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

const CHANGELOG_FIXTURE = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"## [0.10.1] — 2026-07-21",
	"",
	"### Fixed",
	"",
	"- something",
	"",
].join("\n");

describe("commitWrites", () => {
	test("writes every file when all writes succeed", () => {
		const dir = mkdtempSync(join(tmpdir(), "version-bump-"));
		try {
			const a = join(dir, "a.txt");
			const b = join(dir, "b.txt");
			writeFileSync(a, "old-a");
			writeFileSync(b, "old-b");
			commitWrites([
				{ path: a, original: "old-a", updated: "new-a" },
				{ path: b, original: "old-b", updated: "new-b" },
			]);
			expect(readFileSync(a, "utf8")).toBe("new-a");
			expect(readFileSync(b, "utf8")).toBe("new-b");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("restores already-written files when a later write throws", () => {
		const dir = mkdtempSync(join(tmpdir(), "version-bump-"));
		try {
			const a = join(dir, "a.txt");
			writeFileSync(a, "old-a");
			// A directory path can never be written as a file — the second write
			// throws, which must roll the first one back.
			const unwritable = join(dir, "nested-dir");
			mkdirSync(unwritable);
			expect(() =>
				commitWrites([
					{ path: a, original: "old-a", updated: "new-a" },
					{ path: unwritable, original: "", updated: "boom" },
				]),
			).toThrow();
			expect(readFileSync(a, "utf8")).toBe("old-a");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("bumpSemver", () => {
	test("bumps each level", () => {
		expect(bumpSemver("0.10.1", "patch")).toBe("0.10.2");
		expect(bumpSemver("0.10.1", "minor")).toBe("0.11.0");
		expect(bumpSemver("0.10.1", "major")).toBe("1.0.0");
	});

	test("rejects a non-release version", () => {
		expect(() => bumpSemver("0.11.0-rc.1", "patch")).toThrow(/non-release version/);
	});
});

describe("resolveNextVersion", () => {
	test("accepts an explicit version, including a prerelease", () => {
		expect(resolveNextVersion("1.2.3", "0.10.1")).toBe("1.2.3");
		expect(resolveNextVersion("0.11.0-rc.1", "0.10.1")).toBe("0.11.0-rc.1");
	});

	test("rejects a missing, malformed, or unchanged argument", () => {
		expect(() => resolveNextVersion(undefined, "0.10.1")).toThrow(/Usage/);
		expect(() => resolveNextVersion("v1.2.3", "0.10.1")).toThrow(/Usage/);
		expect(() => resolveNextVersion("0.10.1", "0.10.1")).toThrow(/already 0\.10\.1/);
	});
});

describe("rewritePackageVersion", () => {
	test("rewrites the version field", () => {
		const text = '{\n\t"name": "x",\n\t"version": "0.10.1"\n}\n';
		expect(rewritePackageVersion(text, "0.10.1", "0.10.2")).toContain('"version": "0.10.2"');
	});

	test("throws when the current version is not present", () => {
		expect(() => rewritePackageVersion('{"version": "9.9.9"}', "0.10.1", "0.10.2")).toThrow(
			/Could not find/,
		);
	});

	test("matches the real package.json", () => {
		const pkgText = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
		const current = (JSON.parse(pkgText) as { version: string }).version;
		expect(rewritePackageVersion(pkgText, current, "9.9.9")).toContain('"version": "9.9.9"');
	});
});

describe("rewriteIndexVersion", () => {
	test("rewrites the exported constant", () => {
		const text = 'export const VERSION = "0.10.1";\n';
		expect(rewriteIndexVersion(text, "0.10.1", "0.11.0")).toBe(
			'export const VERSION = "0.11.0";\n',
		);
	});

	test("throws when the current version is not present", () => {
		expect(() =>
			rewriteIndexVersion('export const VERSION = "9.9.9";', "0.10.1", "0.10.2"),
		).toThrow(/Could not find/);
	});

	test("matches the real src/index.ts", () => {
		const pkgText = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
		const current = (JSON.parse(pkgText) as { version: string }).version;
		const indexText = readFileSync(resolve(REPO_ROOT, "src/index.ts"), "utf8");
		expect(rewriteIndexVersion(indexText, current, "9.9.9")).toContain(
			'export const VERSION = "9.9.9"',
		);
	});
});

describe("locateReadmeStatusVersion", () => {
	test("returns the bare semver and the offsets of its backticked span", () => {
		const text = "# warren\n\n## Status\n\nStable (`0.10.1`), running on GKE.\n";
		const found = locateReadmeStatusVersion(text);
		expect(found.version).toBe("0.10.1");
		expect(text.slice(found.start, found.end)).toBe("`0.10.1`");
	});

	test("agrees with the real README — the locator check:version-sync imports", () => {
		const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
		const pkgText = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
		expect(locateReadmeStatusVersion(readme).version).toBe(
			(JSON.parse(pkgText) as { version: string }).version,
		);
	});
});

describe("rewriteReadmeStatusVersion", () => {
	test("rewrites the first backticked semver under `## Status`", () => {
		const text = "# warren\n\n`0.0.1` intro\n\n## Status\n\nStable (`0.9.10`), running on GKE.\n";
		const out = rewriteReadmeStatusVersion(text, "0.10.2");
		expect(out).toContain("Stable (`0.10.2`), running on GKE.");
		// The intro version above the heading is left alone.
		expect(out).toContain("`0.0.1` intro");
	});

	test("corrects a drifted status line without knowing the current version", () => {
		const text = "## Status\n\nBeta (`0.9.10`) and counting.\n";
		expect(rewriteReadmeStatusVersion(text, "0.11.0")).toContain("Beta (`0.11.0`)");
	});

	test("throws when the heading or the semver is missing", () => {
		expect(() => rewriteReadmeStatusVersion("# warren\n", "1.0.0")).toThrow(/## Status/);
		expect(() => rewriteReadmeStatusVersion("## Status\n\nStable.\n", "1.0.0")).toThrow(
			/backticked semver/,
		);
	});

	test("matches the real README.md and keeps it in sync with package.json", () => {
		const pkgText = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
		const current = (JSON.parse(pkgText) as { version: string }).version;
		const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
		expect(rewriteReadmeStatusVersion(readme, "9.9.9")).toContain("`9.9.9`");
		// Bumping to the current version must be a no-op — i.e. the README
		// status line already matches package.json.
		expect(rewriteReadmeStatusVersion(readme, current)).toBe(readme);
	});
});

describe("parseChangelogEntries", () => {
	test("keeps PR titles and conventional-commit subjects, drops bookkeeping noise", () => {
		const log = [
			"fix(server): cap event-stream connections (warren-25f6)",
			"seeds: sync 2026-07-27",
			"Fix stale README version tag (#633)",
			"mulch: update expertise",
			"chore(warren): plot state",
			"chore: release v0.10.1",
			"Merge branch 'agent/warren-25f6'",
			"",
		].join("\n");
		expect(parseChangelogEntries(log)).toEqual([
			"fix(server): cap event-stream connections (warren-25f6)",
			"Fix stale README version tag (#633)",
		]);
	});

	test("dedupes repeated subjects and preserves newest-first order", () => {
		const log = ["b (#2)", "a (#1)", "b (#2)"].join("\n");
		expect(parseChangelogEntries(log)).toEqual(["b (#2)", "a (#1)"]);
	});
});

describe("draftUnreleasedSection", () => {
	test("inserts a fenced draft under the [Unreleased] heading", () => {
		const out = draftUnreleasedSection(CHANGELOG_FIXTURE, ["a (#1)", "b (#2)"], "v0.10.1..HEAD");
		expect(out).toContain(DRAFT_START);
		expect(out).toContain(DRAFT_END);
		expect(out).toContain("- a (#1)\n- b (#2)");
		expect(out).toContain("`git log v0.10.1..HEAD`");
		expect(out).toContain("(2 commits, newest first)");
		expect(out.indexOf("## [Unreleased]")).toBeLessThan(out.indexOf(DRAFT_START));
		expect(out.indexOf(DRAFT_END)).toBeLessThan(out.indexOf("## [0.10.1]"));
	});

	test("is idempotent — a re-run replaces the previous draft", () => {
		const once = draftUnreleasedSection(CHANGELOG_FIXTURE, ["a (#1)"], "v0.10.1..HEAD");
		const twice = draftUnreleasedSection(once, ["a (#1)"], "v0.10.1..HEAD");
		expect(twice).toBe(once);
		const rerun = draftUnreleasedSection(once, ["c (#3)"], "v0.10.2..HEAD");
		expect(rerun.split(DRAFT_START).length - 1).toBe(1);
		expect(rerun).toContain("- c (#3)");
		expect(rerun).not.toContain("- a (#1)");
	});

	test("preserves hand-written entries already in the section", () => {
		const withHuman = CHANGELOG_FIXTURE.replace(
			"## [Unreleased]\n",
			"## [Unreleased]\n\n### Added\n\n- hand-written entry\n",
		);
		const out = draftUnreleasedSection(withHuman, ["a (#1)"], "v0.10.1..HEAD");
		expect(out).toContain("- hand-written entry");
		expect(out).toContain("- a (#1)");
	});

	test("creates the heading when the changelog has none", () => {
		const noUnreleased = "# Changelog\n\n## [0.10.1] — 2026-07-21\n\n- old\n";
		const out = draftUnreleasedSection(noUnreleased, ["a (#1)"], "v0.10.1..HEAD");
		expect(out).toContain("## [Unreleased]");
		expect(out.indexOf("## [Unreleased]")).toBeLessThan(out.indexOf("## [0.10.1]"));
	});

	test("notes an empty range instead of emitting an empty list", () => {
		const out = draftUnreleasedSection(CHANGELOG_FIXTURE, [], "v0.10.1..HEAD");
		expect(out).toContain("nothing to draft");
		expect(out).toContain("(0 commits, newest first)");
	});

	test("throws when the changelog has no sections at all", () => {
		expect(() => draftUnreleasedSection("# Changelog\n", ["a"], "r")).toThrow(
			/no release sections/,
		);
	});

	test("leaves the real CHANGELOG.md parseable", () => {
		const changelog = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
		const out = draftUnreleasedSection(changelog, ["a (#1)"], "v0.10.1..HEAD");
		expect(out).toContain(DRAFT_START);
		expect(out.split(DRAFT_START).length - 1).toBe(1);
		// Every pre-existing release heading survives.
		const headings = (text: string) => (text.match(/^## \[/gm) ?? []).length;
		expect(headings(out)).toBe(headings(changelog));
	});

	// A curated section that quotes a sentinel verbatim — easy to do when the
	// entry is about the bumper itself — would make the NEXT bump's
	// stripExistingDraft swallow everything between it and the real marker
	// (warren-222c). Prose must name `version-bump:draft` without the comment
	// delimiters.
	test("the real CHANGELOG.md carries no leftover draft sentinels", () => {
		const changelog = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
		expect(changelog).not.toContain(DRAFT_START);
		expect(changelog).not.toContain(DRAFT_END);
	});
});

describe("CHANGELOG archive split (warren-222c)", () => {
	const ARCHIVE_REL = "docs/CHANGELOG-archive.md";

	test("the live CHANGELOG links the archive and keeps only recent releases", () => {
		const changelog = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
		expect(changelog).toContain(ARCHIVE_REL);
		// Everything at or below 0.9.x lives in the archive now.
		expect(changelog).not.toMatch(/^## \[0\.9\./m);
	});

	test("the archive holds the older history and points back at the live file", () => {
		const archive = readFileSync(resolve(REPO_ROOT, ARCHIVE_REL), "utf8");
		expect(archive).toMatch(/^## \[0\.9\.10\]/m);
		expect(archive).toContain("../CHANGELOG.md");
		// The archive is frozen — the bumper must never target it.
		expect(archive).not.toContain("## [Unreleased]");
	});
});
