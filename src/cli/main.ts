#!/usr/bin/env bun
/**
 * `warren` / `wr` CLI entry (SPEC §8.2).
 *
 * Five subcommands, all dispatching into pure functions in `./commands/`.
 * The dispatch is intentionally thin: commander handles argv parsing and
 * help text, then each command function takes a `CliContext` (env +
 * stdio + spawn) plus parsed args and returns an `exitCode`. That shape
 * keeps the per-command logic unit-testable without spinning up a real
 * subprocess.
 */

import { Command } from "commander";
import { BurrowClientPool } from "../burrow-client/pool.ts";
import { WarrenClient } from "../client/index.ts";
import type { PlanRunState } from "../client/types.ts";
import { openDatabase } from "../db/client.ts";
import { parseDatabaseUrl } from "../db/url.ts";
import { VERSION } from "../index.ts";
import { loadProjectsConfigFromEnv } from "../projects/config.ts";
import { seedBuiltinAgents } from "../registry/builtins/index.ts";
import { requireCanopyRegistryConfigFromEnv } from "../registry/config.ts";
import { runAddProject } from "./commands/add-project.ts";
import { runConfigMigrate } from "./commands/config-migrate.ts";
import { runMigrateToPostgres } from "./commands/db.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInit } from "./commands/init.ts";
import { runPlanCancel, runPlanRun } from "./commands/plan-run.ts";
import { runPlanList, runPlanStatus } from "./commands/plan-status.ts";
import { runRegisterAgent } from "./commands/register-agent.ts";
import { runRun } from "./commands/run.ts";
import { runServe } from "./commands/serve.ts";
import { withCliDb } from "./context.ts";
import { type CliContext, defaultSpawn, formatError, PROCESS_STDIO } from "./output.ts";
import type { PlanRunOutput } from "./plan-run-renderer.ts";

export function buildProgram(context: CliContext): Command {
	const program = new Command();
	program
		.name("warren")
		.description("Control plane and UI for cloud-based custom agents")
		.version(VERSION)
		.exitOverride((err) => {
			// Let commander handle --help / --version exits, but never let it
			// kill the process from inside a test harness. Re-throwing here
			// surfaces the error to the caller.
			throw err;
		});

	program
		.command("register-agent")
		.description("refresh canopy and register one agent into warren's cache")
		.argument("<name>", "canopy prompt name (must be tagged 'agent')")
		.action(async (name: string) => {
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				// register-agent only makes sense against a configured library —
				// built-ins are seeded automatically and can't be 'registered'
				// from canopy. requireCanopyRegistryConfigFromEnv throws a
				// ValidationError with a friendly hint when CANOPY_REPO_URL is
				// unset; main's catch surfaces it.
				const canopyConfig = requireCanopyRegistryConfigFromEnv(context.env);
				const result = await runRegisterAgent(
					context,
					{ agents: repos.agents, canopyConfig },
					{ name },
				);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	program
		.command("add-project")
		.description("clone a GitHub repo into the projects root and persist it")
		.argument("<git-url>", "GitHub URL (https or git@)")
		.option("--default-branch <name>", "override the auto-detected default branch")
		.action(async (gitUrl: string, opts: { defaultBranch?: string }) => {
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				const projectsConfig = loadProjectsConfigFromEnv(context.env);
				const result = await runAddProject(
					context,
					{ projects: repos.projects, projectsConfig },
					{
						gitUrl,
						...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
					},
				);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	program
		.command("run")
		.description("spawn a one-shot run, tail events as NDJSON, and exit")
		.argument("<agent>", "registered agent name")
		.argument("<project>", "project id (prj_xxx)")
		.requiredOption("-p, --prompt <text>", "prompt text the agent receives")
		.option("--trigger <label>", "run trigger label", "cli")
		.option("--provider <name>", "per-run override of agent frontmatter.provider")
		.option("--model <name>", "per-run override of agent frontmatter.model")
		.action(
			async (
				agent: string,
				project: string,
				opts: {
					prompt: string;
					trigger?: string;
					provider?: string;
					model?: string;
				},
			) => {
				const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
					// Seed built-ins so `warren run claude-code <prj> -p ...` works
					// against a fresh DB without first registering the agent from
					// a canopy library (warren-d3e9). Idempotent against existing
					// rows.
					await seedBuiltinAgents(repos.agents, undefined, context.now);
					// warren-39c3 / warren-c0c9: build a single-worker pool from env
					// so spawnRun can resolve placement and the bridge/reap/state-
					// fetch paths can resolve per-burrow workers via `clientFor`.
					// The pool registers a synthetic `local` row in `workers` and
					// forwards the env-derived BurrowClient as its only entry,
					// mirroring the zero-config bootServer path.
					const burrowClientPool = await BurrowClientPool.fromEnv({
						env: context.env,
						repos,
					});
					try {
						const result = await runRun(
							context,
							{ repos, burrowClientPool },
							{
								agent,
								project,
								prompt: opts.prompt,
								...(opts.trigger !== undefined ? { trigger: opts.trigger } : {}),
								...(opts.provider !== undefined ? { providerOverride: opts.provider } : {}),
								...(opts.model !== undefined ? { modelOverride: opts.model } : {}),
							},
						);
						return result.exitCode;
					} finally {
						await burrowClientPool.close().catch(() => undefined);
					}
				});
				process.exit(exitCode);
			},
		);

	program
		.command("init")
		.description("scaffold a .warren/ directory (triggers.yaml + config.yaml) in a project repo")
		.option("--project <id>", "target a registered project by id (writes into its warren clone)")
		.option("--cwd <path>", "target a directory on disk (defaults to process.cwd())")
		.option("--default-role <name>", "pin defaults.defaultRole to this registered agent")
		.action(async (opts: { project?: string; cwd?: string; defaultRole?: string }) => {
			if (opts.project !== undefined && opts.cwd !== undefined) {
				context.stdio.stderr.write("warren: --project and --cwd are mutually exclusive\n");
				process.exit(2);
			}
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				seedBuiltinAgents(repos.agents, undefined, context.now);
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
				const result = await runInit(
					context,
					{ projects: repos.projects, agents: repos.agents },
					args,
				);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	// `config` is a subcommand group rather than a flat top-level so future
	// .warren/ admin tools (validate, dump, edit) can land alongside without
	// inflating warren's first-page help. Today it has one child:
	// `migrate` (warren-5840 — defaults.json → config.yaml + preview.yaml).
	const configGroup = program.command("config").description(".warren/ admin tools");
	configGroup
		.command("migrate")
		.description(
			"convert legacy .warren/defaults.json into the warren-5840 YAML layout (config.yaml + preview.yaml)",
		)
		.option("--project <id>", "target a registered project by id (writes into its warren clone)")
		.option("--cwd <path>", "target a directory on disk (defaults to process.cwd())")
		.action(async (opts: { project?: string; cwd?: string }) => {
			if (opts.project !== undefined && opts.cwd !== undefined) {
				context.stdio.stderr.write("warren: --project and --cwd are mutually exclusive\n");
				process.exit(2);
			}
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				const args =
					opts.project !== undefined
						? { mode: "project" as const, projectId: opts.project }
						: { mode: "cwd" as const, cwd: opts.cwd ?? process.cwd() };
				const result = await runConfigMigrate(context, { projects: repos.projects }, args);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	program
		.command("doctor")
		.description("check warren's environment: env vars, burrow socket, canopy clone")
		.option("--no-auth", "skip the WARREN_API_TOKEN check (loopback dev mode)")
		.action(async (opts: { auth?: boolean }) => {
			// commander turns `--no-auth` into `opts.auth === false`.
			// Open the DB so the warren_config check can walk every
			// registered project. A missing DB file is fine — withCliDb's
			// openDatabase creates one on first use; an empty projects
			// table produces an informational `ok: true`.
			const exitCode = await withCliDb({ env: context.env }, async ({ db, repos }) => {
				const projects = (await repos.projects.listAll()).map((p) => ({
					id: p.id,
					localPath: p.localPath,
				}));
				const result = await runDoctor(context, { projects, db }, { noAuth: opts.auth === false });
				return result.exitCode;
			});
			process.exit(exitCode);
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
	// the first command family that talks to a remote warren via
	// WarrenClient.fromEnv rather than opening a local DB with withCliDb.
	const planGroup = program.command("plan").description("dispatch and steer cloud plan-runs");
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
		.option("--plot <id>", "associate the plan-run with a Plot (plt_xxx)")
		.option("--no-follow", "dispatch and exit without tailing events")
		.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson")
		.action(
			async (
				planId: string,
				opts: {
					project: string;
					agent: string;
					promptTemplate?: string;
					ref?: string;
					provider?: string;
					model?: string;
					plot?: string;
					follow: boolean;
					output?: string;
				},
			) => {
				const client = WarrenClient.fromEnv(context.env);
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
						...(opts.plot !== undefined ? { plot: opts.plot } : {}),
					},
				);
				process.exit(result.exitCode);
			},
		);
	planGroup
		.command("cancel")
		.description("cancel a remote plan-run and its in-flight child run")
		.argument("<plan-run-id>", "plan-run id")
		.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson")
		.action(async (planRunId: string, opts: { output?: string }) => {
			const client = WarrenClient.fromEnv(context.env);
			const result = await runPlanCancel(
				context,
				{ client },
				{ planRunId, output: parsePlanRunOutput(opts.output) },
			);
			process.exit(result.exitCode);
		});
	planGroup
		.command("status")
		.description("render a plan-run's child-state table with per-child cost + duration")
		.argument("<plan-run-id>", "plan-run id")
		.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson")
		.action(async (planRunId: string, opts: { output?: string }) => {
			const client = WarrenClient.fromEnv(context.env);
			const result = await runPlanStatus(
				context,
				{ client },
				{ planRunId, output: parsePlanRunOutput(opts.output) },
			);
			process.exit(result.exitCode);
		});
	planGroup
		.command("list")
		.description("list plan-runs, optionally filtered by project / state")
		.option("--project <id>", "only plan-runs for this project (prj_xxx)")
		.option(
			"--state <state>",
			"only plan-runs in this state (queued|running|succeeded|failed|cancelled)",
		)
		.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson")
		.action(async (opts: { project?: string; state?: string; output?: string }) => {
			const client = WarrenClient.fromEnv(context.env);
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

/** The set of recognised plan-run states for the `plan list --state` filter. */
const PLAN_RUN_STATES: ReadonlySet<string> = new Set([
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);

/** Coerce a `--state` flag value to a {@link PlanRunState}, or undefined when unset/invalid. */
export function parsePlanRunState(value: string | undefined): PlanRunState | undefined {
	return value !== undefined && PLAN_RUN_STATES.has(value) ? (value as PlanRunState) : undefined;
}

if (import.meta.main) {
	const context: CliContext = {
		env: process.env,
		stdio: PROCESS_STDIO,
		spawn: defaultSpawn,
	};
	const program = buildProgram(context);
	program.parseAsync(process.argv).catch((err) => {
		// Commander throws for unknown commands / missing required args;
		// it has already printed a usage hint to stderr.
		const code = (err as { exitCode?: unknown }).exitCode;
		if (typeof code === "number") {
			process.exit(code);
		}
		process.stderr.write(`warren: ${formatError(err)}\n`);
		process.exit(1);
	});
}
