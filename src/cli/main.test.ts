import { describe, expect, test } from "bun:test";
import { CommanderError } from "commander";
import { resolveCliExitCode } from "./flags.ts";
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
	test("registers all subcommands + the `init` scaffolder + `db` admin group + `config` group", () => {
		const program = buildProgram(silentContext());
		const names = program.commands.map((c) => c.name()).sort();
		expect(names).toEqual([
			"add-project",
			"cancel",
			"config",
			"db",
			"doctor",
			"init",
			"login",
			"plan",
			"prime",
			"run",
			"serve",
			"show",
			"tail",
			"wait",
		]);
	});

	test("`plan` group registers run/cancel/status/list (warren-ec6a, warren-5e3f)", () => {
		const program = buildProgram(silentContext());
		const planCmd = program.commands.find((c) => c.name() === "plan");
		expect(planCmd).toBeDefined();
		const subNames = planCmd?.commands.map((c) => c.name()).sort() ?? [];
		expect(subNames).toEqual(["cancel", "list", "run", "status"]);
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

describe("global --output contract (warren-b61e)", () => {
	test("the program registers a global --output option", () => {
		const program = buildProgram(silentContext());
		const opt = program.options.find((o) => o.long === "--output");
		expect(opt).toBeDefined();
	});

	test("help epilogue renders the stable exit-code table", () => {
		const program = buildProgram(silentContext());
		let help = "";
		program.configureOutput({
			writeOut: (chunk) => {
				help += chunk;
			},
		});
		program.outputHelp();
		expect(help).toContain("Exit codes:");
		expect(help).toContain("server-unreachable");
		expect(help).toContain("auth-rejected");
		expect(help).toContain("sigint-detach");
	});

	test("an invalid --output value exits 2 before the command runs", async () => {
		const errChunks: string[] = [];
		const context: CliContext = {
			env: {},
			stdio: {
				stdout: { write: () => undefined },
				stderr: {
					write: (chunk) => {
						errChunks.push(chunk);
					},
				},
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		};
		const program = buildProgram(context);
		program.exitOverride();
		const err = await program
			.parseAsync(["node", "warren", "--output", "yaml", "doctor"])
			.catch((e: unknown) => e);
		expect((err as { exitCode?: number }).exitCode).toBe(2);
		expect(errChunks.join("")).toContain("invalid --output mode");
	});
});

describe("resolveCliExitCode", () => {
	test("maps every non-zero commander usage error to the documented exit 2", () => {
		expect(resolveCliExitCode(new CommanderError(1, "commander.invalidArgument", "bad"))).toBe(2);
		expect(resolveCliExitCode(new CommanderError(1, "commander.missingArgument", "bad"))).toBe(2);
		expect(resolveCliExitCode(new CommanderError(1, "commander.unknownCommand", "bad"))).toBe(2);
	});

	test("keeps --help/--version at exit 0 and non-commander failures at exit 1", () => {
		expect(resolveCliExitCode(new CommanderError(0, "commander.helpDisplayed", "help"))).toBe(0);
		expect(resolveCliExitCode(new Error("boom"))).toBe(1);
	});

	test("an invalid --max-cost-usd maps to the usage-error exit 2 (warren-b61e)", async () => {
		const program = buildProgram(silentContext());
		program.configureOutput({ writeErr: () => undefined });
		const err = await program
			.parseAsync(["node", "warren", "run", "agent", "prj_x", "-p", "x", "--max-cost-usd", "abc"])
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CommanderError);
		expect(resolveCliExitCode(err)).toBe(2);
	});
});
