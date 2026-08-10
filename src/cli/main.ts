#!/usr/bin/env bun
/**
 * `warren` / `wr` CLI entry.
 *
 * Post-warren-97a2 (owner decision D3) the CLI collapses onto HTTP: a
 * local user is a remote user pointed at localhost. Remote-capable
 * commands (`run`, `add-project`, `doctor`, `init`, `config migrate`,
 * the `plan` group) resolve a WarrenClient from `--url`/`--token` flags
 * + `WARREN_BASE_URL`/`WARREN_API_TOKEN` env (client config holds base
 * URL + token ONLY — D5) and drive the server through the SDK. The
 * genuinely-local remainder is exactly `serve`, `db migrate-to-postgres`,
 * and `doctor --local` (the deployment-side checks).
 *
 * The dispatch is intentionally thin: commander handles argv parsing and
 * help text, then each command function takes a `CliContext` (env +
 * stdio + spawn) plus parsed args and returns an `exitCode`. That shape
 * keeps the per-command logic unit-testable without spinning up a real
 * subprocess.
 */

import { Command, CommanderError } from "commander";
import { PLAN_RUN_STATES, type PlanRunState } from "../core/wire.ts";
import { openDatabase } from "../db/client.ts";
import { parseDatabaseUrl } from "../db/url.ts";
import { VERSION } from "../index.ts";
import { addClientFlags, clientFlags, type RemoteOpts, resolveWarrenClient } from "./client.ts";
import { runAddProject } from "./commands/add-project.ts";
import { registerBootstrapCommands } from "./commands/bootstrap.ts";
import { runConfigMigrate } from "./commands/config-migrate.ts";
import { runMigrateToPostgres } from "./commands/db.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runRemoteDoctor } from "./commands/doctor-remote.ts";
import { runInit } from "./commands/init.ts";
import { runPlanCancel, runPlanRun } from "./commands/plan-run.ts";
import { runPlanList, runPlanStatus } from "./commands/plan-status.ts";
import { runRun } from "./commands/run.ts";
import { runServe } from "./commands/serve.ts";
import { withCliDb } from "./context.ts";
import { parseMaxCostUsd, resolveCliExitCode } from "./flags.ts";
import {
	type CliContext,
	defaultSpawn,
	EXIT_USAGE,
	formatError,
	formatExitCodeTable,
	OUTPUT_MODES,
	type OutputMode,
	PROCESS_STDIO,
	parseOutputMode,
} from "./output.ts";
import type { PlanRunOutput } from "./plan-run-renderer.ts";
import { registerRunCommands } from "./register-run-commands.ts";

export function buildProgram(baseContext: CliContext): Command {
	const program = new Command();
	program
		.name("warren")
		.description("Control plane and UI for cloud-based custom agents")
		.version(VERSION)
		.option(
			"--output <mode>",
			`global output mode: ${OUTPUT_MODES.join("|")} (default ndjson; agents script against ndjson/json, pretty is the human opt-in)`,
		)
		.addHelpText("after", `\nExit codes:\n${formatExitCodeTable()}\n`)
		.exitOverride((err) => {
			// Let commander handle --help / --version exits, but never let it
			// kill the process from inside a test harness. Re-throwing here
			// surfaces the error to the caller.
			throw err;
		});

	// Reject an unknown global --output value before any command runs,
	// mapping it to the stable usage-error exit code (warren-b61e).
	program.hook("preAction", () => {
		const raw = program.opts().output as string | undefined;
		if (raw !== undefined && parseOutputMode(raw) === null) {
			baseContext.stdio.stderr.write(
				`warren: invalid --output mode ${JSON.stringify(raw)} (expected ${OUTPUT_MODES.join("|")})\n`,
			);
			throw new CommanderError(EXIT_USAGE, "commander.invalidOutput", "invalid --output mode");
		}
	});

	// Thread the resolved global --output through the CliContext every
	// command receives (warren-b61e). Read lazily: commander populates
	// program.opts() at parse time, after buildProgram returns. The `plan`
	// group keeps its own per-command --output (ndjson|pretty), which
	// shadows the global for those subcommands (backward compat).
	const context: CliContext = {
		...baseContext,
		get output(): OutputMode | undefined {
			return parseOutputMode(program.opts().output as string | undefined) ?? undefined;
		},
	};

	addClientFlags(
		program
			.command("add-project")
			.description("register a project on the warren server (POST /projects)")
			.argument("<git-url>", "GitHub URL (https or git@)")
			.option("--default-branch <name>", "override the auto-detected default branch"),
	).action(async (gitUrl: string, opts: { defaultBranch?: string } & RemoteOpts) => {
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const result = await runAddProject(
			context,
			{ client },
			{
				gitUrl,
				...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
			},
		);
		process.exit(result.exitCode);
	});

	addClientFlags(
		program
			.command("run")
			.description(
				"dispatch a one-shot run against the warren server, tail events as NDJSON, and exit",
			)
			.argument("<agent>", "registered agent name")
			.argument("<project>", "project id (prj_xxx)")
			.requiredOption("-p, --prompt <text>", "prompt text the agent receives")
			.option("--trigger <label>", "run trigger label", "cli")
			.option("--provider <name>", "per-run override of agent frontmatter.provider")
			.option("--model <name>", "per-run override of agent frontmatter.model")
			.option(
				"--max-cost-usd <usd>",
				"per-run USD spend cap; wins over the agent's own and the project default",
				parseMaxCostUsd,
			),
	).action(
		async (
			agent: string,
			project: string,
			opts: {
				prompt: string;
				trigger?: string;
				provider?: string;
				model?: string;
				maxCostUsd?: number;
			} & RemoteOpts,
		) => {
			const client = resolveWarrenClient(context.env, clientFlags(opts));
			const result = await runRun(
				context,
				{ client },
				{
					agent,
					project,
					prompt: opts.prompt,
					...(opts.trigger !== undefined ? { trigger: opts.trigger } : {}),
					...(opts.provider !== undefined ? { providerOverride: opts.provider } : {}),
					...(opts.model !== undefined ? { modelOverride: opts.model } : {}),
					...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
				},
			);
			process.exit(result.exitCode);
		},
	);

	addClientFlags(
		program
			.command("init")
			.description("scaffold a .warren/ directory (triggers.yaml + config.yaml) in a project repo")
			.option("--project <id>", "target a registered project by id (writes into its warren clone)")
			.option("--cwd <path>", "target a directory on disk (defaults to process.cwd())")
			.option("--default-role <name>", "pin defaults.defaultRole to this registered agent"),
	).action(async (opts: { project?: string; cwd?: string; defaultRole?: string } & RemoteOpts) => {
		if (opts.project !== undefined && opts.cwd !== undefined) {
			context.stdio.stderr.write("warren: --project and --cwd are mutually exclusive\n");
			process.exit(2);
		}
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const args =
			opts.project !== undefined
				? {
						mode: "project" as const,
						projectId: opts.project,
						...(opts.defaultRole !== undefined ? { defaultRole: opts.defaultRole } : {}),
					}
				: {
						mode: "cwd" as const,
						cwd: opts.cwd ?? process.cwd(),
						...(opts.defaultRole !== undefined ? { defaultRole: opts.defaultRole } : {}),
					};
		const result = await runInit(context, { client }, args);
		process.exit(result.exitCode);
	});

	// `config` is a subcommand group rather than a flat top-level so future
	// .warren/ admin tools (validate, dump, edit) can land alongside without
	// inflating warren's first-page help. Today it has one child:
	// `migrate` (warren-5840 — defaults.json → config.yaml + preview.yaml).
	const configGroup = program.command("config").description(".warren/ admin tools");
	addClientFlags(
		configGroup
			.command("migrate")
			.description(
				"convert legacy .warren/defaults.json into the warren-5840 YAML layout (config.yaml + preview.yaml)",
			)
			.option("--project <id>", "target a registered project by id (writes into its warren clone)")
			.option("--cwd <path>", "target a directory on disk (defaults to process.cwd())"),
	).action(async (opts: { project?: string; cwd?: string } & RemoteOpts) => {
		if (opts.project !== undefined && opts.cwd !== undefined) {
			context.stdio.stderr.write("warren: --project and --cwd are mutually exclusive\n");
			process.exit(2);
		}
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const args =
			opts.project !== undefined
				? { mode: "project" as const, projectId: opts.project }
				: { mode: "cwd" as const, cwd: opts.cwd ?? process.cwd() };
		const result = await runConfigMigrate(context, { client }, args);
		process.exit(result.exitCode);
	});

	addClientFlags(
		program
			.command("doctor")
			.description(
				"check the client's view of a warren server (reachable? auth valid? version match?)",
			)
			.option(
				"--local",
				"run the deployment-side checks instead (env vars, burrow socket, bwrap, DB)",
			)
			.option("--no-auth", "skip the auth check (loopback dev mode)")
			.option(
				"--verbose",
				"print raw probe/driver output (withheld from check messages) to stderr",
			),
	).action(async (opts: { local?: boolean; auth?: boolean; verbose?: boolean } & RemoteOpts) => {
		// commander turns `--no-auth` into `opts.auth === false`.
		if (opts.local === true) {
			// Deployment-side half (warren-97a2): only meaningful on the host
			// warren is deployed on, so it keeps its local DB lifecycle.
			// A missing DB file is fine — withCliDb's openDatabase creates one
			// on first use; an empty projects table produces an informational
			// `ok: true`.
			const exitCode = await withCliDb({ env: context.env }, async ({ db, repos }) => {
				const projects = (await repos.projects.listAll()).map((p) => ({
					id: p.id,
					localPath: p.localPath,
				}));
				const result = await runDoctor(
					context,
					{ projects, db },
					{ noAuth: opts.auth === false, verbose: opts.verbose === true },
				);
				return result.exitCode;
			});
			process.exit(exitCode);
		}
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const result = await runRemoteDoctor(context, { client }, { noAuth: opts.auth === false });
		process.exit(result.exitCode);
	});

	// `db` is a subcommand group rather than a flat top-level so future
	// db-admin tools (dump, restore, prune) can land alongside without
	// inflating warren's first-page help. Today it has one child:
	// `migrate-to-postgres` (R-13, pl-f17e step 8, warren-14ac).
	const dbGroup = program.command("db").description("database admin tools");
	dbGroup
		.command("migrate-to-postgres")
		.description("one-shot copy of a SQLite warren.db into a Postgres database")
		.requiredOption(
			"--from <sqlite>",
			"source SQLite path or URL (bare path, sqlite://, file://, :memory:)",
		)
		.requiredOption("--to <pg-url>", "target Postgres URL (postgres:// or postgresql://)")
		.action(async (opts: { from: string; to: string }) => {
			const fromParsed = parseDatabaseUrl(opts.from);
			if (fromParsed.dialect !== "sqlite") {
				context.stdio.stderr.write(
					`warren: --from must be a SQLite source (got dialect=${fromParsed.dialect})\n`,
				);
				process.exit(2);
			}
			const toParsed = parseDatabaseUrl(opts.to);
			if (toParsed.dialect !== "postgres") {
				context.stdio.stderr.write(
					`warren: --to must be a Postgres URL (got dialect=${toParsed.dialect})\n`,
				);
				process.exit(2);
			}
			// Source: open read-only-style. We don't run sqlite migrations
			// against an existing operator warren.db — the schema is
			// already at the journal head, and skipping migrations keeps
			// the tool from touching the source's mtime.
			const source = await openDatabase({ url: opts.from, skipMigrations: true });
			if (source.dialect !== "sqlite") {
				// Belt-and-suspenders: parseDatabaseUrl already enforced this.
				await source.close().catch(() => undefined);
				throw new Error(`expected sqlite source, got ${source.dialect}`);
			}
			// Target: open with migrations so a freshly-provisioned pg
			// database (empty schema) lands at the right journal head
			// before we copy rows into it.
			const target = await openDatabase({ url: opts.to });
			if (target.dialect !== "postgres") {
				await source.close().catch(() => undefined);
				await target.close().catch(() => undefined);
				throw new Error(`expected postgres target, got ${target.dialect}`);
			}
			try {
				const result = await runMigrateToPostgres(context, { source, target });
				process.exit(result.exitCode);
			} finally {
				await source.close().catch(() => undefined);
				await target.close().catch(() => undefined);
			}
		});

	// `plan` is a thin HTTP-client subcommand group (warren-ec6a, pl-55df) —
	// the first command family that talked to a remote warren rather than
	// opening a local DB with withCliDb.
	const planGroup = program.command("plan").description("dispatch and steer cloud plan-runs");
	addClientFlags(
		planGroup
			.command("run")
			.description("dispatch a serial plan-run against a remote warren and tail events as NDJSON")
			.argument("<plan-id>", "seeds plan id (pl_xxx)")
			.requiredOption("--project <id>", "project id (prj_xxx)")
			.requiredOption("--agent <name>", "registered agent name")
			.option("--prompt-template <text>", "per-child prompt template override")
			.option("--ref <git-ref>", "git ref to clone child workspaces from")
			.option("--provider <name>", "per-run override of agent frontmatter.provider")
			.option("--model <name>", "per-run override of agent frontmatter.model")
			.option(
				"--max-cost-usd <usd>",
				"per-child USD spend cap applied to every child dispatch",
				parseMaxCostUsd,
			)
			.option("--no-follow", "dispatch and exit without tailing events")
			.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson"),
	).action(
		async (
			planId: string,
			opts: {
				project: string;
				agent: string;
				promptTemplate?: string;
				ref?: string;
				provider?: string;
				model?: string;
				maxCostUsd?: number;
				follow: boolean;
				output?: string;
			} & RemoteOpts,
		) => {
			const client = resolveWarrenClient(context.env, clientFlags(opts));
			const result = await runPlanRun(
				context,
				{ client },
				{
					planId,
					project: opts.project,
					agent: opts.agent,
					follow: opts.follow,
					output: parsePlanRunOutput(opts.output),
					...(opts.promptTemplate !== undefined ? { promptTemplate: opts.promptTemplate } : {}),
					...(opts.ref !== undefined ? { ref: opts.ref } : {}),
					...(opts.provider !== undefined ? { provider: opts.provider } : {}),
					...(opts.model !== undefined ? { model: opts.model } : {}),
					...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
				},
			);
			process.exit(result.exitCode);
		},
	);
	addClientFlags(
		planGroup
			.command("cancel")
			.description("cancel a remote plan-run and its in-flight child run")
			.argument("<plan-run-id>", "plan-run id")
			.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson"),
	).action(async (planRunId: string, opts: { output?: string } & RemoteOpts) => {
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const result = await runPlanCancel(
			context,
			{ client },
			{ planRunId, output: parsePlanRunOutput(opts.output) },
		);
		process.exit(result.exitCode);
	});
	addClientFlags(
		planGroup
			.command("status")
			.description("render a plan-run's child-state table with per-child cost + duration")
			.argument("<plan-run-id>", "plan-run id")
			.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson"),
	).action(async (planRunId: string, opts: { output?: string } & RemoteOpts) => {
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const result = await runPlanStatus(
			context,
			{ client },
			{ planRunId, output: parsePlanRunOutput(opts.output) },
		);
		process.exit(result.exitCode);
	});
	addClientFlags(
		planGroup
			.command("list")
			.description("list plan-runs, optionally filtered by project / state")
			.option("--project <id>", "only plan-runs for this project (prj_xxx)")
			.option(
				"--state <state>",
				"only plan-runs in this state (queued|running|succeeded|failed|cancelled)",
			)
			.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson"),
	).action(async (opts: { project?: string; state?: string; output?: string } & RemoteOpts) => {
		const client = resolveWarrenClient(context.env, clientFlags(opts));
		const result = await runPlanList(
			context,
			{ client },
			{
				output: parsePlanRunOutput(opts.output),
				...(opts.project !== undefined ? { project: opts.project } : {}),
				...(parsePlanRunState(opts.state) !== undefined
					? { state: parsePlanRunState(opts.state) }
					: {}),
			},
		);
		process.exit(result.exitCode);
	});

	// Agent-facing run read/control commands (warren-b048).
	registerRunCommands(program, context);

	// Session bootstrap pair (warren-fc12, pl-882c step 11): `login` stores
	// base URL + token in the client config (D5); `prime` emits the agent
	// session context derived from this very program definition.
	registerBootstrapCommands(program, context);

	program
		.command("serve")
		.description("start the HTTP server (default in docker entrypoint)")
		.option("--no-auth", "boot without bearer-token auth (loopback only)")
		.action(async (opts: { auth?: boolean }) => {
			const result = await runServe(context, {}, { noAuth: opts.auth === false });
			process.exit(result.exitCode);
		});

	return program;
}

/** Coerce a `--output` flag value to a {@link PlanRunOutput}, defaulting `ndjson`. */
export function parsePlanRunOutput(value: string | undefined): PlanRunOutput {
	return value === "pretty" ? "pretty" : "ndjson";
}

/**
 * Coerce a `--state` flag value to a {@link PlanRunState}, or undefined when
 * unset/invalid. Membership is tested against the canonical tuple rather than
 * a locally rebuilt `Set` — that copy was drift waiting to happen (warren-d371).
 */
export function parsePlanRunState(value: string | undefined): PlanRunState | undefined {
	return value !== undefined && (PLAN_RUN_STATES as readonly string[]).includes(value)
		? (value as PlanRunState)
		: undefined;
}

if (import.meta.main) {
	const context: CliContext = {
		env: process.env,
		stdio: PROCESS_STDIO,
		spawn: defaultSpawn,
	};
	const program = buildProgram(context);
	program.parseAsync(process.argv).catch((err) => {
		// Commander throws for unknown commands / missing required args /
		// invalid option values; it has already printed a usage hint to
		// stderr, so only non-commander rejections need a message here.
		if (!(err instanceof CommanderError)) {
			process.stderr.write(`warren: ${formatError(err)}\n`);
		}
		process.exit(resolveCliExitCode(err));
	});
}
