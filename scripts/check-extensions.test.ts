import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverExtensions,
	type ExtensionPlan,
	type RunCommand,
	runExtensionGates,
} from "./check-extensions.ts";

let root: string;

function writeExtension(name: string, scripts: Record<string, string>, installed = false): void {
	const dir = join(root, "extensions", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, scripts }));
	if (installed) mkdirSync(join(dir, "node_modules"));
}

/** A recorder that answers ok unless `failing` names the `<cwd-basename> <gate>`. */
function recorder(failing: ReadonlySet<string> = new Set()): {
	run: RunCommand;
	calls: string[];
} {
	const calls: string[] = [];
	const run: RunCommand = (cwd, argv) => {
		const key = `${cwd.split("/").pop()} ${argv.join(" ")}`;
		calls.push(key);
		return failing.has(key) ? { ok: false, output: `boom from ${key}` } : { ok: true, output: "" };
	};
	return { run, calls };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "check-extensions-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("discoverExtensions", () => {
	test("returns nothing when the extensions directory is absent", () => {
		expect(discoverExtensions(root)).toEqual([]);
	});

	test("plans only the gates each package declares, sorted by name", () => {
		writeExtension("zeta", { typecheck: "tsc", lint: "biome check src" });
		writeExtension("alpha", { typecheck: "tsc" }, true);
		writeExtension("no-gates", { start: "bun run src/index.ts" });
		mkdirSync(join(root, "extensions", "not-a-package"));
		const plans = discoverExtensions(root);
		expect(plans.map((p) => p.name)).toEqual([
			"extensions/alpha",
			"extensions/no-gates",
			"extensions/zeta",
		]);
		expect(plans[0]?.gates).toEqual(["typecheck"]);
		expect(plans[0]?.installed).toBe(true);
		expect(plans[1]?.gates).toEqual([]);
		expect(plans[2]?.gates).toEqual(["typecheck", "lint"]);
		expect(plans[2]?.installed).toBe(false);
	});

	test("sees every shipped extension's typecheck script", () => {
		const plans = discoverExtensions();
		expect(plans.length).toBeGreaterThanOrEqual(6);
		for (const plan of plans) expect(plan.gates).toContain("typecheck");
	});
});

describe("runExtensionGates", () => {
	const plan = (
		name: string,
		gates: ExtensionPlan["gates"],
		installed: boolean,
	): ExtensionPlan => ({
		dir: `/repo/extensions/${name}`,
		name: `extensions/${name}`,
		gates,
		installed,
	});

	test("runs each declared gate in order and skips packages with none", () => {
		const { run, calls } = recorder();
		const results = runExtensionGates(
			[plan("a", ["typecheck", "lint"], true), plan("b", [], true)],
			run,
		);
		expect(calls).toEqual(["a bun run typecheck", "a bun run lint"]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.map((r) => r.gate)).toEqual(["typecheck", "lint"]);
	});

	test("installs with a frozen lockfile first when node_modules is missing", () => {
		const { run, calls } = recorder();
		runExtensionGates([plan("a", ["typecheck"], false)], run);
		expect(calls).toEqual(["a bun install --frozen-lockfile", "a bun run typecheck"]);
	});

	test("reports a red gate with its output and keeps running the rest", () => {
		const { run } = recorder(new Set(["a bun run typecheck"]));
		const results = runExtensionGates(
			[plan("a", ["typecheck", "lint"], true), plan("b", ["typecheck"], true)],
			run,
		);
		expect(results.map((r) => [r.name, r.gate, r.ok])).toEqual([
			["extensions/a", "typecheck", false],
			["extensions/a", "lint", true],
			["extensions/b", "typecheck", true],
		]);
		expect(results[0]?.output).toContain("boom from a bun run typecheck");
	});

	test("a failed install fails the package's first gate and names the cause", () => {
		const { run, calls } = recorder(new Set(["a bun install --frozen-lockfile"]));
		const results = runExtensionGates([plan("a", ["typecheck", "lint"], false)], run);
		expect(calls).toEqual(["a bun install --frozen-lockfile"]);
		expect(results).toHaveLength(1);
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.gate).toBe("typecheck");
		expect(results[0]?.output).toContain("bun install --frozen-lockfile failed");
	});
});
