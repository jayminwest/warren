import { describe, expect, test } from "bun:test";
import { buildProgram } from "./main.ts";
import type { CliContext } from "./output.ts";
import { type CommandEntry, collectCommandReference, collectGlobalOptions } from "./reference.ts";

function testProgram() {
	const context: CliContext = {
		env: {},
		stdio: { stdout: { write: () => undefined }, stderr: { write: () => undefined } },
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};
	return buildProgram(context);
}

function byName(commands: readonly CommandEntry[], name: string): CommandEntry {
	const entry = commands.find((c) => c.name === name);
	if (entry === undefined) throw new Error(`command ${name} not found`);
	return entry;
}

describe("collectCommandReference", () => {
	test("flattens the program tree into full-path command names", () => {
		const names = collectCommandReference(testProgram()).map((c) => c.name);
		for (const expected of [
			"add-project",
			"run",
			"init",
			"config",
			"config migrate",
			"doctor",
			"db",
			"db migrate-to-postgres",
			"plan",
			"plan run",
			"plan cancel",
			"plan status",
			"plan list",
			"show",
			"wait",
			"tail",
			"cancel",
			"login",
			"prime",
			"serve",
		]) {
			expect(names).toContain(expected);
		}
	});

	test("marks grouping commands and keeps declaration order", () => {
		const commands = collectCommandReference(testProgram());
		expect(byName(commands, "plan").isGroup).toBe(true);
		expect(byName(commands, "config").isGroup).toBe(true);
		expect(byName(commands, "db").isGroup).toBe(true);
		expect(byName(commands, "run").isGroup).toBe(false);
		// Declaration order: a group is immediately followed by its children.
		const names = commands.map((c) => c.name);
		expect(names.indexOf("config migrate")).toBe(names.indexOf("config") + 1);
		expect(names.indexOf("plan run")).toBe(names.indexOf("plan") + 1);
	});

	test("captures positional arguments with requiredness", () => {
		const run = byName(collectCommandReference(testProgram()), "run");
		expect(run.arguments.map((a) => ({ name: a.name, required: a.required }))).toEqual([
			{ name: "agent", required: true },
			{ name: "project", required: true },
		]);
		const addProject = byName(collectCommandReference(testProgram()), "add-project");
		expect(addProject.arguments[0]?.name).toBe("git-url");
		expect(addProject.arguments[0]?.description).toContain("GitHub");
	});

	test("distinguishes mandatory options from defaulted ones", () => {
		const run = byName(collectCommandReference(testProgram()), "run");
		const prompt = run.options.find((o) => o.flags.includes("--prompt"));
		expect(prompt?.mandatory).toBe(true);
		expect(prompt?.defaultValue).toBeUndefined();
		const trigger = run.options.find((o) => o.flags.includes("--trigger"));
		expect(trigger?.mandatory).toBe(false);
		expect(trigger?.defaultValue).toBe("cli");
	});

	test("carries the commander-computed usage tail", () => {
		const commands = collectCommandReference(testProgram());
		expect(byName(commands, "run").usage).toBe("[options] <agent> <project>");
		expect(byName(commands, "plan run").usage).toBe("[options] [plan-id]");
	});
});

describe("collectGlobalOptions", () => {
	test("returns the program-level flags", () => {
		const flags = collectGlobalOptions(testProgram()).map((o) => o.flags);
		expect(flags).toContain("--output <mode>");
		expect(flags).toContain("-V, --version");
	});
});
