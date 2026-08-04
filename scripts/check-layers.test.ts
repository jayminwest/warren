import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	importSpec,
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

describe("importSpec", () => {
	test("sees import, side-effect import, re-export and multi-line closing forms", () => {
		expect(importSpec('import { x } from "../server/types.ts";')).toBe("../server/types.ts");
		expect(importSpec('import "@os-eco/burrow-cli";')).toBe("@os-eco/burrow-cli");
		expect(importSpec('export { x } from "./types.ts";')).toBe("./types.ts");
		expect(importSpec('} from "../../seeds-cli/index.ts";')).toBe("../../seeds-cli/index.ts");
	});

	test("ignores comment lines", () => {
		expect(importSpec('// import { x } from "../server/types.ts";')).toBeUndefined();
		expect(importSpec(' * see `from "../server/types.ts"`')).toBeUndefined();
	});
});

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

describe("scan — the burrow seam warren-f796 used to own alone", () => {
	test("flags a facade import outside the local-topology allowlist", () => {
		withFixtureRepo(
			{ "src/runs/spawn.ts": 'import { c } from "../burrow-client/index.ts";\n' },
			(dir) => {
				expect(scan(dir, RULES)).toEqual([
					{
						rule: "burrow-facade-is-local-only",
						file: "src/runs/spawn.ts",
						line: 1,
						reason: 'imports "../burrow-client/index.ts"',
					},
				]);
			},
		);
	});

	test("allows the facade in the four homes the old guard allowed", () => {
		withFixtureRepo(
			{
				"src/burrow-client/client.ts": 'import { e } from "./errors.ts";\n',
				"src/runtime/local/provider.ts": 'import { c } from "../../burrow-client/index.ts";\n',
				"src/supervisor/main.ts": 'import { c } from "../burrow-client/index.ts";\n',
				"src/runtime/registry.ts": 'import { c } from "../burrow-client/index.ts";\n',
			},
			(dir) => {
				expect(scan(dir, RULES)).toEqual([]);
			},
		);
	});

	test("flags the @os-eco/burrow-cli package outside its allowlist but not in src/runtime/k8s/", () => {
		withFixtureRepo(
			{
				"src/runtime/k8s/agent-entrypoint.ts":
					'import { AgentRegistry } from "@os-eco/burrow-cli";\n',
				"src/projects/clone.ts": 'import { HttpClient } from "@os-eco/burrow-cli";\n',
			},
			(dir) => {
				expect(scan(dir, RULES).map((v) => `${v.rule} ${v.file}`)).toEqual([
					"burrow-package-is-local-only src/projects/clone.ts",
				]);
			},
		);
	});

	test("the package allowlist stays narrower than the facade's, as warren-f796 had it", () => {
		// `src/runtime/registry.ts` may hold the `() => BurrowClient` factory seam
		// but not reach for burrow's own library.
		withFixtureRepo(
			{ "src/runtime/registry.ts": 'import { HttpClient } from "@os-eco/burrow-cli";\n' },
			(dir) => {
				expect(scan(dir, RULES).map((v) => v.rule)).toEqual(["burrow-package-is-local-only"]);
			},
		);
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
		withFixtureRepo(
			{
				"src/server/handlers/runs/lifecycle.ts":
					'import type { RunRow } from "../../../db/schema.ts";\n',
				"src/server/handlers/agents.ts": 'import { agents } from "../../db/schema/agents.ts";\n',
			},
			(dir) => {
				// `src/db/schema.ts` is the type barrel and stays legal; the rule is
				// about the drizzle table modules under `src/db/schema/`.
				expect(scan(dir, RULES).map((v) => v.file)).toEqual(["src/server/handlers/agents.ts"]);
			},
		);
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
	test("still declares both halves of the retired burrow guard", () => {
		const names = RULES.map((r) => r.name);
		expect(names).toContain("burrow-facade-is-local-only");
		expect(names).toContain("burrow-package-is-local-only");
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
