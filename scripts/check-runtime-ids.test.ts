import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	ADAPTER_ROOT,
	enforcedLiterals,
	isAllowed,
	scan,
	scanText,
	staleAllowEntries,
	VOCABULARY_HOME,
} from "./check-runtime-ids.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** A stand-in for src/core/wire-runtime.ts. */
const FIXTURE_HOME = [
	'export const KNOWN_RUNTIME_IDS = ["claude-code", "pi"] as const;',
	"export type RuntimeId = (typeof KNOWN_RUNTIME_IDS)[number];",
].join("\n");

function writeFixtureRepo(dir: string, files: Record<string, string>): void {
	const all = { [VOCABULARY_HOME]: `${FIXTURE_HOME}\n`, ...files };
	for (const [rel, text] of Object.entries(all)) {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text);
	}
}

function withFixtureRepo(files: Record<string, string>, run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "warren-runtime-ids-"));
	try {
		writeFixtureRepo(dir, files);
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("enforcedLiterals", () => {
	test("derives the ids from the vocabulary home instead of a hand-copied list", () => {
		withFixtureRepo({}, (dir) => {
			expect(enforcedLiterals(dir)).toEqual(["claude-code", "pi"]);
		});
	});

	test("follows the declaration when a runtime is removed", () => {
		withFixtureRepo({}, (dir) => {
			writeFixtureRepo(dir, {
				[VOCABULARY_HOME]: 'export const KNOWN_RUNTIME_IDS = ["pi"] as const;\n',
			});
			expect(enforcedLiterals(dir)).toEqual(["pi"]);
		});
	});

	test("refuses to guess when the declaration cannot be read", () => {
		withFixtureRepo({ [VOCABULARY_HOME]: "export const NOTHING = 1;\n" }, (dir) => {
			expect(() => enforcedLiterals(dir)).toThrow(/KNOWN_RUNTIME_IDS/);
		});
	});
});

describe("scanText", () => {
	const literals = ["claude-code", "pi"];

	test("reports a literal with its line", () => {
		const text = ["const a = 1;", 'if (id === "claude-code") return;'].join("\n");
		expect(scanText("src/x.ts", text, literals)).toEqual([
			{ file: "src/x.ts", line: 2, literal: "claude-code" },
		]);
	});

	test("ignores literals inside comments", () => {
		const text = ['// pick "pi" here', ' * or "claude-code" there', '/* "pi" again */'].join("\n");
		expect(scanText("src/x.ts", text, literals)).toEqual([]);
	});

	test("does not match an id that is only part of a longer word", () => {
		expect(scanText("src/x.ts", 'const s = "pinned";\n', literals)).toEqual([]);
	});

	test("reports both ids on one line", () => {
		const found = scanText("src/x.ts", 'x = usePi ? "pi" : "claude-code";\n', literals);
		expect(found.map((v) => v.literal).sort()).toEqual(["claude-code", "pi"]);
	});
});

describe("scan", () => {
	test("fails a literal written outside the adapter registry", () => {
		withFixtureRepo({ "src/runs/thing.ts": 'if (id === "pi") return 1;\n' }, (dir) => {
			expect(scan(dir)).toEqual([{ file: "src/runs/thing.ts", line: 1, literal: "pi" }]);
		});
	});

	test("allows the adapter registry itself", () => {
		withFixtureRepo({ [`${ADAPTER_ROOT}pi-argv.ts`]: 'export const ID = "pi";\n' }, (dir) => {
			expect(scan(dir)).toEqual([]);
		});
	});

	test("exempts test files and helpers", () => {
		withFixtureRepo(
			{
				"src/runs/thing.test.ts": 'const id = "pi";\n',
				"src/runs/thing.test-helpers.ts": 'const id = "claude-code";\n',
			},
			(dir) => {
				expect(scan(dir)).toEqual([]);
			},
		);
	});

	test("exempts an allowlisted file", () => {
		withFixtureRepo({ "src/registry/builtins/pi.ts": 'runtime: "pi",\n' }, (dir) => {
			expect(scan(dir)).toEqual([]);
		});
	});
});

describe("staleAllowEntries", () => {
	test("reports an allowlisted file that no longer writes a literal", () => {
		withFixtureRepo({ "src/registry/builtins/pi.ts": "export const NOTHING = 1;\n" }, (dir) => {
			expect(staleAllowEntries(dir)).toContain("src/registry/builtins/pi.ts");
		});
	});
});

describe("isAllowed", () => {
	test("covers both allowlist buckets", () => {
		expect(isAllowed("src/registry/builtins/pi.ts")).toBe(true);
		expect(isAllowed("src/runtime/local/profile.ts")).toBe(true);
		expect(isAllowed("src/runs/somewhere-new.ts")).toBe(false);
	});
});

describe("the real repo", () => {
	test("has no runtime-id literal outside the seam", () => {
		expect(scan(REPO_ROOT)).toEqual([]);
	});

	test("carries no stale allowlist entry", () => {
		expect(staleAllowEntries(REPO_ROOT)).toEqual([]);
	});
});
