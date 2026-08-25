import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type LayerRule,
	loadRules,
	matchesPath,
	matchesTarget,
	resolveSpec,
	scan,
	scanText,
} from "./check-layers.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The real manifest — fixture trees are scanned against the shipped rules. */
const RULES = loadRules(REPO_ROOT);

function ruleNamed(name: string): LayerRule {
	const rule = RULES.find((r) => r.name === name);
	if (rule === undefined) throw new Error(`no rule named ${name}`);
	return rule;
}

/** Write a fake repo whose `src/` tree holds `files`, then scan it. */
function withFixtureRepo(files: Record<string, string>, run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "warren-layers-"));
	try {
		for (const [rel, text] of Object.entries(files)) {
			const abs = join(dir, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, text);
		}
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("matchesPath", () => {
	test("a trailing slash is a directory prefix, anything else is an exact file", () => {
		expect(matchesPath("src/runtime/local/provider.ts", ["src/runtime/local/"])).toBe(true);
		expect(matchesPath("src/runtime/registry.ts", ["src/runtime/local/"])).toBe(false);
		expect(matchesPath("src/runtime/registry.ts", ["src/runtime/registry.ts"])).toBe(true);
		expect(matchesPath("src/runtime/registry.test.ts", ["src/runtime/registry.ts"])).toBe(false);
	});
});

describe("matchesTarget", () => {
	test("directory prefixes match the directory itself and everything under it", () => {
		expect(matchesTarget("src/server/types.ts", ["src/server/"])).toBe(true);
		expect(matchesTarget("src/server", ["src/server/"])).toBe(true);
		expect(matchesTarget("src/server-config/env.ts", ["src/server/"])).toBe(false);
	});

	test("bare entries match a package and its subpaths", () => {
		expect(matchesTarget("@os-eco/burrow-cli", ["@os-eco/burrow-cli"])).toBe(true);
		expect(matchesTarget("@os-eco/burrow-cli/agent", ["@os-eco/burrow-cli"])).toBe(true);
		expect(matchesTarget("@os-eco/burrow-cli-extras", ["@os-eco/burrow-cli"])).toBe(false);
	});

	test("`*` matches every target, which is how the kernel rule forbids all imports", () => {
		expect(matchesTarget("node:fs", ["*"])).toBe(true);
		expect(matchesTarget("src/core/wire.ts", ["*"])).toBe(true);
	});
});

describe("resolveSpec", () => {
	test("resolves a relative specifier against the importing file", () => {
		expect(resolveSpec("src/plan-runs/dispatch.ts", "../server/types.ts")).toBe(
			"src/server/types.ts",
		);
		expect(resolveSpec("src/preview/proxy/types.ts", "../../server/types.ts")).toBe(
			"src/server/types.ts",
		);
	});

	test("src/seeds-cli/ is not src/cli/ once the specifier is resolved", () => {
		// The whole reason specifiers are resolved rather than substring-matched:
		// nine domain modules import `../../seeds-cli/index.ts`.
		expect(resolveSpec("src/runs/reap/seeds.ts", "../../seeds-cli/index.ts")).toBe(
			"src/seeds-cli/index.ts",
		);
		expect(matchesTarget("src/seeds-cli/index.ts", ["src/cli/"])).toBe(false);
	});

	test("bare package specifiers pass through untouched", () => {
		expect(resolveSpec("src/runtime/k8s/agent.ts", "@os-eco/burrow-cli")).toBe(
			"@os-eco/burrow-cli",
		);
	});
});

// Edge extraction itself (dynamic import, require, export-from, type-only,
// comment/string blindness) is covered in scripts/layer-graph.test.ts.

describe("scanText", () => {
	test("reports the 1-based line and the specifier as written", () => {
		const rule = ruleNamed("domain-owns-the-logic");
		const text = [
			'import { a } from "./b.ts";',
			"",
			'import type { C } from "../server/types.ts";',
		];
		expect(scanText(rule, "src/plan-runs/dispatch.ts", text.join("\n"))).toEqual([
			{
				rule: "domain-owns-the-logic",
				file: "src/plan-runs/dispatch.ts",
				line: 3,
				reason: 'imports "../server/types.ts"',
			},
		]);
	});

	test("exceptImports carves a target back out of a `*` forbid", () => {
		const rule = ruleNamed("core-kernel-imports-nothing");
		expect(scanText(rule, "src/core/ids.ts", 'import { x } from "./wire.ts";\n')).toEqual([]);
		expect(
			scanText(rule, "src/core/ids.ts", 'import { x } from "../db/client.ts";\n'),
		).toHaveLength(1);
	});

	test("a pattern rule flags a repo built out of deps.db and spares the guard clause", () => {
		const rule = ruleNamed("handlers-do-not-build-repos");
		const text = [
			"if (deps.db === undefined) return null;",
			"const spread = { ...(deps.db !== undefined ? { db: deps.db } : {}) };",
			"const previews = createRunPreviewsRepo(deps.db);",
		].join("\n");
		expect(scanText(rule, "src/server/handlers/runs/preview.ts", text)).toEqual([
			{
				rule: "handlers-do-not-build-repos",
				file: "src/server/handlers/runs/preview.ts",
				line: 3,
				reason: `matches /${rule.forbidPattern}/`,
			},
		]);
	});

	test("a pattern rule ignores the doc comment that names the same expression", () => {
		const rule = ruleNamed("handlers-do-not-build-repos");
		expect(
			scanText(rule, "src/server/handlers/metrics.ts", " * DrizzleAdapter.for(deps.db)\n"),
		).toEqual([]);
	});
});

describe("scan — the seams warren-89a6 added", () => {
	test("flags the three domain to server imports it had to repair", () => {
		withFixtureRepo(
			{
				"src/plan-runs/dispatch.ts": 'import type { B } from "../server/types.ts";\n',
				"src/preview/proxy/types.ts": 'import type { P } from "../../server/types.ts";\n',
				"src/observability/error-tracking.ts": 'import { S } from "../server/main/redact.ts";\n',
			},
			(dir) => {
				expect(
					scan(dir, RULES)
						.map((v) => v.file)
						.sort(),
				).toEqual([
					"src/observability/error-tracking.ts",
					"src/plan-runs/dispatch.ts",
					"src/preview/proxy/types.ts",
				]);
			},
		);
	});

	test("leaves the nine domain modules that import src/seeds-cli/ alone", () => {
		withFixtureRepo(
			{
				"src/runs/reap/seeds.ts": 'import { closeSeed } from "../../seeds-cli/index.ts";\n',
				"src/triggers/tick.ts": 'import type { S } from "../seeds-cli/index.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES)).toEqual([]);
			},
		);
	});

	test("flags a CLI command reaching into the server, except `warren serve`", () => {
		withFixtureRepo(
			{
				"src/cli/commands/serve.ts": 'import { bootServer } from "../../server/main/index.ts";\n',
				"src/cli/commands/status.ts":
					'import { buildRoutes } from "../../server/handlers/index.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => v.file)).toEqual(["src/cli/commands/status.ts"]);
			},
		);
	});

	test("flags a handler reaching for a drizzle table", () => {
		const rule = ruleNamed("handlers-are-a-thin-surface");
		const rel = "src/server/handlers/x.ts";
		// warren-02c9: the barrel `src/db/schema.ts` is banned too; row types live at the seams.
		expect(scanText(rule, rel, 'import { runs } from "../../db/schema/runs.ts";\n')).toHaveLength(
			1,
		);
		expect(scanText(rule, rel, 'import type { RunRow } from "../../db/schema.ts";\n')).toHaveLength(
			1,
		);
		expect(scanText(rule, rel, 'import type { RunRow } from "../../runs/index.ts";\n')).toEqual([]);
	});

	test("flags a handler assembling a repo from deps.db", () => {
		withFixtureRepo(
			{
				"src/server/handlers/metrics.ts": "const a = DrizzleAdapter.for(deps.db);\n",
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => v.rule)).toEqual(["handlers-do-not-build-repos"]);
			},
		);
	});
	test("the UI seam flags server-only imports, spares the kernel, ndjson reader and itself (warren-f0ae)", () => {
		const rule = ruleNamed("ui-is-a-browser-consumer");
		const rel = "src/ui/src/a.ts";
		expect(scanText(rule, rel, 'import { s } from "../../server/main.ts";\n')).toHaveLength(1);
		for (const spec of ["../../../core/wire.ts", "../../../client/ndjson.ts", "../lib/f.ts"]) {
			expect(scanText(rule, rel, `import { x } from "${spec}";\n`)).toEqual([]);
		}
	});
	test("flags any import in the dependency-free kernel", () => {
		withFixtureRepo(
			{
				"src/core/ids.ts": 'import { randomUUID } from "node:crypto";\n',
				"src/core/wire.ts": 'export { X } from "./ids.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => v.file)).toEqual(["src/core/ids.ts"]);
			},
		);
	});
});

describe("scan — walk scope", () => {
	test("skips the built UI bundle under dist (warren-30ef)", () => {
		withFixtureRepo(
			{ "src/ui/dist/assets/bundle.ts": 'import { c } from "../../../burrow-client/index.ts";\n' },
			(dir) => {
				expect(scan(dir, RULES)).toEqual([]);
			},
		);
	});

	test("exempts test files and test helpers", () => {
		withFixtureRepo(
			{
				"src/runs/spawn.test.ts": 'import { c } from "../burrow-client/index.ts";\n',
				"src/runs/spawn.test-helpers.ts": 'import type { B } from "../server/types.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES)).toEqual([]);
			},
		);
	});
});

describe("scan — the widened scripts/ walk (warren-c042)", () => {
	test("the walk reaches scripts/: a scripts file importing an extension is flagged", () => {
		// `core-does-not-import-extensions` declares scripts/ in `from` and was
		// inert before the walk widened. This fixture has no src/ tree at all —
		// a hit proves the scripts/ walk exists.
		withFixtureRepo(
			{
				"scripts/foo.ts": 'import { z } from "../extensions/audit-log/src/index.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => v.rule)).toEqual(["core-does-not-import-extensions"]);
			},
		);
	});

	test("flags an api.github.com literal in scripts/", () => {
		withFixtureRepo(
			{
				"scripts/acceptance/scenarios/99-foo.ts":
					'const BASE = "https://api.github.com/repos/o/r";\n',
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => v.rule)).toEqual(["github-api-literal-is-forge-only"]);
			},
		);
	});

	test("the forge literal rule spares source-level comments in scripts/", () => {
		withFixtureRepo(
			{
				"scripts/acceptance/scenarios/99-foo.ts":
					" * hits the `api.github.com` check-runs endpoint\n",
			},
			(dir) => {
				expect(scan(dir, RULES)).toEqual([]);
			},
		);
	});

	test("flags a scripts file importing forge transport, except the acceptance seam helper", () => {
		withFixtureRepo(
			{
				"scripts/acceptance/lib/github.ts":
					'import { GITHUB_API_BASE } from "../../../src/forge/github/headers.ts";\n',
				"scripts/fresh-client.ts":
					'import { request } from "octokit";\nimport { h } from "../src/forge/github/headers.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => `${v.rule} ${v.file} ${v.line}`)).toEqual([
					"forge-transport-is-forge-only scripts/fresh-client.ts 1",
					"forge-transport-is-forge-only scripts/fresh-client.ts 2",
				]);
			},
		);
	});
});

describe("scan — the extension boundary (warren-0781, plan pl-116e)", () => {
	test("flags an extension importing warren's src/ or scripts/", () => {
		withFixtureRepo(
			{
				"extensions/audit-log/src/collector.ts": 'import { X } from "../../../src/core/wire.ts";\n',
				"extensions/audit-log/src/helper.ts":
					'import { Y } from "../../../scripts/check-layers.ts";\n',
			},
			(dir) => {
				// The filesystem walk order is platform-dependent, so sort the
				// findings by file the way the warren-89a6 multi-finding tests do.
				expect(scan(dir, RULES).sort((a, b) => a.file.localeCompare(b.file))).toEqual([
					{
						rule: "extensions-are-standalone",
						file: "extensions/audit-log/src/collector.ts",
						line: 1,
						reason: 'imports "../../../src/core/wire.ts"',
					},
					{
						rule: "extensions-are-standalone",
						file: "extensions/audit-log/src/helper.ts",
						line: 1,
						reason: 'imports "../../../scripts/check-layers.ts"',
					},
				]);
			},
		);
	});

	test("flags core importing an extension", () => {
		withFixtureRepo(
			{
				"src/server/main/lifecycle-bus-wiring.ts":
					'import { z } from "../../../extensions/audit-log/src/index.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => v.rule)).toEqual(["core-does-not-import-extensions"]);
			},
		);
	});

	test("both directions stay forbidden for every shipped extension, including campaign-controller (warren-772a)", () => {
		// The campaign-controller scaffold must not weaken the seam it is born
		// under: a file inside it importing src/, and a src/ file importing it,
		// both fire — in one scan, proving the two rules are symmetric.
		withFixtureRepo(
			{
				"extensions/campaign-controller/src/controller.ts":
					'import { X } from "../../../src/core/wire.ts";\n',
				"src/server/main/wiring.ts":
					'import { y } from "../../../extensions/campaign-controller/src/index.ts";\n',
			},
			(dir) => {
				const rules = scan(dir, RULES)
					.map((v) => `${v.rule} ${v.file}`)
					.sort();
				expect(rules).toEqual([
					"core-does-not-import-extensions src/server/main/wiring.ts",
					"extensions-are-standalone extensions/campaign-controller/src/controller.ts",
				]);
			},
		);
	});

	test("leaves an extension's own internal imports alone", () => {
		withFixtureRepo(
			{
				"extensions/audit-log/src/index.ts":
					'import { c } from "./collector.ts";\nimport { Database } from "bun:sqlite";\n',
			},
			(dir) => {
				expect(scan(dir, RULES)).toEqual([]);
			},
		);
	});

	test("the reverse-direction rule is not theater: the walk reaches extensions/", () => {
		// Plan risk 1: if the walk silently never covered extensions/, the
		// import rule would never fire. This fixture has no src/ tree at all —
		// a hit proves the extensions/ walk exists.
		withFixtureRepo(
			{
				"extensions/audit-log/src/x.ts": 'import { w } from "../../../src/core/wire.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES)).toHaveLength(1);
			},
		);
	});
});

describe("the shipped manifest", () => {
	test("the retired burrow guard is gone with its import targets (warren-ea0a)", () => {
		// Both burrow rules guarded `src/burrow-client/` and `@os-eco/burrow-cli`.
		// The excision deleted both targets, so the rules guard nothing real and
		// left with them — this pins the retirement.
		const names = RULES.map((r) => r.name);
		expect(names).not.toContain("burrow-facade-is-local-only");
		expect(names).not.toContain("burrow-package-is-local-only");
	});

	test("declares both directions of the extension boundary", () => {
		const names = RULES.map((r) => r.name);
		expect(names).toContain("extensions-are-standalone");
		expect(names).toContain("core-does-not-import-extensions");
	});

	test("every allow entry carries a reason, because JSON has no comments", () => {
		for (const rule of RULES) {
			for (const entry of rule.allow ?? []) {
				expect(entry.why.length).toBeGreaterThan(0);
			}
		}
	});

	test("every rule forbids something", () => {
		for (const rule of RULES) {
			expect(rule.forbidImports !== undefined || rule.forbidPattern !== undefined).toBe(true);
		}
	});

	test("the real repository tree is clean", () => {
		expect(scan(REPO_ROOT, RULES)).toEqual([]);
	});
});
