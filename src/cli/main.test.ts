import { describe, expect, test } from "bun:test";
import { buildProgram } from "./main.ts";
import type { CliContext } from "./output.ts";

function silentContext(): CliContext {
	return {
		env: {},
		stdio: {
			stdout: { write: () => undefined },
			stderr: { write: () => undefined },
		},
		spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};
}

describe("buildProgram", () => {
	test("registers all SPEC §8.2 subcommands + the `init` scaffolder + `db` admin group + `config` group", () => {
		const program = buildProgram(silentContext());
		const names = program.commands.map((c) => c.name()).sort();
		expect(names).toEqual([
			"add-project",
			"config",
			"db",
			"doctor",
			"init",
			"plan",
			"register-agent",
			"run",
			"serve",
		]);
	});

	test("`plan run` + `plan cancel` are registered under the plan group (warren-ec6a)", () => {
		const program = buildProgram(silentContext());
		const planCmd = program.commands.find((c) => c.name() === "plan");
		expect(planCmd).toBeDefined();
		const subNames = planCmd?.commands.map((c) => c.name()).sort() ?? [];
		expect(subNames).toEqual(["cancel", "run"]);
		const runCmd = planCmd?.commands.find((c) => c.name() === "run");
		expect(runCmd?.options.find((o) => o.long === "--project")?.mandatory).toBe(true);
		expect(runCmd?.options.find((o) => o.long === "--agent")?.mandatory).toBe(true);
		// commander models `--no-follow` as a boolean `follow` option defaulting to true.
		expect(runCmd?.options.find((o) => o.long === "--no-follow")).toBeDefined();
	});

	test("`db migrate-to-postgres` is registered under the db group", () => {
		const program = buildProgram(silentContext());
		const dbCmd = program.commands.find((c) => c.name() === "db");
		expect(dbCmd).toBeDefined();
		const subNames = dbCmd?.commands.map((c) => c.name()).sort() ?? [];
		expect(subNames).toEqual(["migrate-to-postgres"]);
		const migrateCmd = dbCmd?.commands.find((c) => c.name() === "migrate-to-postgres");
		const fromOpt = migrateCmd?.options.find((o) => o.long === "--from");
		const toOpt = migrateCmd?.options.find((o) => o.long === "--to");
		expect(fromOpt?.mandatory).toBe(true);
		expect(toOpt?.mandatory).toBe(true);
	});

	test("`config migrate` is registered under the config group (warren-5840)", () => {
		const program = buildProgram(silentContext());
		const configCmd = program.commands.find((c) => c.name() === "config");
		expect(configCmd).toBeDefined();
		const subNames = configCmd?.commands.map((c) => c.name()).sort() ?? [];
		expect(subNames).toEqual(["migrate"]);
		const migrateCmd = configCmd?.commands.find((c) => c.name() === "migrate");
		const projectOpt = migrateCmd?.options.find((o) => o.long === "--project");
		const cwdOpt = migrateCmd?.options.find((o) => o.long === "--cwd");
		expect(projectOpt).toBeDefined();
		expect(cwdOpt).toBeDefined();
	});

	test("--version reports the package VERSION constant", () => {
		const program = buildProgram(silentContext());
		// Commander surfaces version via .version() which is the same string from src/index.ts.
		expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("`run` requires a --prompt option", () => {
		const program = buildProgram(silentContext());
		const runCmd = program.commands.find((c) => c.name() === "run");
		expect(runCmd).toBeDefined();
		const promptOpt = runCmd?.options.find((o) => o.long === "--prompt");
		expect(promptOpt?.mandatory).toBe(true);
	});
});
