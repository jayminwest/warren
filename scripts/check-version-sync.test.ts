import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	collectGroups,
	findDrift,
	formatDrift,
	readIndexVersion,
	readOpenapiVersion,
	readPackageVersion,
	type SiteGroup,
} from "./check-version-sync.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** A minimal in-sync repo tree the collector can read end to end. */
function writeFixtureRepo(dir: string, version: string): void {
	const files: Record<string, string> = {
		"package.json": `${JSON.stringify({ version }, null, "\t")}\n`,
		"src/index.ts": `export const VERSION = "${version}";\n`,
		"docs/openapi.yaml": `openapi: 3.1.0\ninfo:\n  title: warren HTTP API\n  version: ${version}\n`,
		"README.md": ["# warren", "", "## Status", "", `Stable (\`${version}\`).`, ""].join("\n"),
	};
	for (const [rel, text] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text);
	}
}

function group(name: string, versions: string[]): SiteGroup {
	return {
		name,
		sites: versions.map((version, i) => ({ file: `file-${i}`, where: "somewhere", version })),
	};
}

describe("readPackageVersion", () => {
	test("reads the version field", () => {
		expect(readPackageVersion('{"version": "1.2.3"}')).toBe("1.2.3");
	});

	test("throws when the field is missing", () => {
		expect(() => readPackageVersion("{}")).toThrow(/no string `version`/);
	});
});

describe("readIndexVersion", () => {
	test("reads the exported VERSION constant", () => {
		expect(readIndexVersion('export const VERSION = "1.2.3";\n')).toBe("1.2.3");
	});

	test("throws when the constant is missing", () => {
		expect(() => readIndexVersion("export const NAME = 'warren';\n")).toThrow(/const VERSION/);
	});
});

describe("readOpenapiVersion", () => {
	test("reads info.version", () => {
		expect(readOpenapiVersion("openapi: 3.1.0\ninfo:\n  title: t\n  version: 1.2.3\n")).toBe(
			"1.2.3",
		);
	});

	test("throws when info.version is missing", () => {
		expect(() => readOpenapiVersion("openapi: 3.1.0\ninfo:\n  title: t\n")).toThrow(/info.version/);
	});
});

describe("findDrift", () => {
	test("reports nothing when every site in every group agrees", () => {
		expect(findDrift([group("a", ["1.0.0", "1.0.0"]), group("b", ["2.0.0"])])).toEqual([]);
	});

	test("measures every other site against the first (canonical) one", () => {
		const drift = findDrift([group("release", ["1.0.0", "0.9.0", "1.0.0", "0.8.0"])]);
		expect(drift).toHaveLength(1);
		expect(drift[0]?.canonical.version).toBe("1.0.0");
		expect(drift[0]?.mismatches.map((s) => s.version)).toEqual(["0.9.0", "0.8.0"]);
	});

	test("tolerates an empty group", () => {
		expect(findDrift([group("empty", [])])).toEqual([]);
	});
});

describe("formatDrift", () => {
	test("names the canonical site and every out-of-sync one", () => {
		const out = formatDrift(findDrift([group("release", ["1.0.0", "0.9.0"])]));
		expect(out).toContain("release");
		expect(out).toContain("canonical is 1.0.0");
		expect(out).toContain("file-1");
		expect(out).toContain("0.9.0");
	});
});

describe("collectGroups", () => {
	test("reads all four version sites", () => {
		const dir = mkdtempSync(join(tmpdir(), "version-sync-"));
		try {
			writeFixtureRepo(dir, "1.2.3");
			const groups = collectGroups(dir);
			const [release] = groups;
			expect(release?.sites.map((s) => s.file)).toEqual([
				"package.json",
				"src/index.ts",
				"docs/openapi.yaml",
				"README.md",
			]);
			expect(release?.sites.every((s) => s.version === "1.2.3")).toBe(true);
			expect(findDrift(groups)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("bumping package.json alone drifts every other version site", () => {
		const dir = mkdtempSync(join(tmpdir(), "version-sync-"));
		try {
			writeFixtureRepo(dir, "1.2.3");
			writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.3.0" }, null, "\t"));
			const drift = findDrift(collectGroups(dir));
			expect(drift).toHaveLength(1);
			expect(drift[0]?.mismatches.map((s) => s.file)).toEqual([
				"src/index.ts",
				"docs/openapi.yaml",
				"README.md",
			]);
			expect(formatDrift(drift)).toContain("canonical is 1.3.0");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the real repo is in sync (this is what the gate asserts)", () => {
		expect(findDrift(collectGroups(REPO_ROOT))).toEqual([]);
	});
});
