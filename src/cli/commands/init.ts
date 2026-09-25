/**
 * `warren init` — scaffold a `.warren/` directory inside a project repo
 * (warren-bd22, R-02 producer-side affordance).
 *
 * Today the `.warren/` convention is purely loader-side: warren reads
 * `.warren/triggers.yaml` and `.warren/config.yaml` from a project clone
 * but offers no help producing them. This command closes that gap by
 * writing a canonical, schema-valid skeleton:
 *
 *   `.warren/triggers.yaml`  empty list with a comment header
 *   `.warren/config.yaml`    YAML defaults block (post-warren-5840 layout)
 *
 * Two target modes:
 *
 *   `--cwd` (default)    scaffolds into the operator's current working
 *                        directory — used when the operator has the
 *                        project repo checked out somewhere and will
 *                        commit + push themselves. Pure local write via
 *                        the domain scaffold; never touches the server.
 *   `--project <id>`     scaffolds into the warren clone at
 *                        `<projects-root>/.../<repo>` — ON THE SERVER
 *                        (warren-166d). `POST /projects/:id/init` does the
 *                        write where the clone actually lives, so the CLI
 *                        works against a remote warren instead of needing
 *                        to share the server's filesystem. Useful for
 *                        warren-on-warren, in-container flows, and the
 *                        external-repo mirror recipe
 *                        (docs/onboarding-external-repos.md); operator
 *                        still owns the commit + push (e.g. via the
 *                        project repo upstream).
 *
 * No git side-effects: this is intentionally a write-and-stop. The
 * heavier UI variant (B) in warren-bd22 — commit + push from warren's
 * service identity — is deferred until warren has a sanctioned
 * project-repo write path beyond `git push` from reap.
 *
 * Refuses to overwrite either file, including the legacy
 * `.warren/defaults.json` left over from a pre-warren-5840 install — that
 * file should be migrated via `warren config migrate` before scaffolding.
 * The template + render logic lives once in the domain
 * (`src/projects/warren-scaffold.ts`), shared with the server route.
 */

import { type WarrenClient, WarrenClientError } from "../../client/index.ts";
import { ValidationError } from "../../core/errors.ts";
import { scaffoldWarrenConfig } from "../../projects/index.ts";
import { type DefaultsConfig, parseConfigFile } from "../../warren-config/schema.ts";
import type { CliContext } from "../output.ts";
import { commandFailure, writeResult } from "../output.ts";
import { resolveTargetDir } from "./target-dir.ts";

export type InitArgs =
	| {
			readonly mode: "cwd";
			readonly cwd: string;
			readonly defaultRole?: string;
	  }
	| {
			readonly mode: "project";
			readonly projectId: string;
			readonly defaultRole?: string;
	  };

export interface InitDeps {
	/**
	 * Remote warren client (warren-97a2). `--project` dispatches through
	 * `POST /projects/:id/init` (warren-166d); `--default-role` validates
	 * against `GET /agents/:name`. The CLI never opens the server's DB.
	 */
	readonly client: WarrenClient;
}

export interface InitResult {
	readonly exitCode: number;
}

export async function runInit(
	context: CliContext,
	deps: InitDeps,
	args: InitArgs,
): Promise<InitResult> {
	try {
		if (args.mode === "project") {
			// The role lookups (`GET /agents`, `GET /agents/:name`) are remote
			// calls, so `--project` mode validates the role exactly like
			// `--cwd` mode before the write goes to the server.
			const defaults = await resolveDefaults(deps, args);
			const res = await deps.client.initProject(args.projectId, {
				...(defaults.defaultRole !== undefined ? { defaultRole: defaults.defaultRole } : {}),
			});
			writeResult(
				context,
				{
					ok: true,
					scaffolded: {
						project: args.projectId,
						files: res.scaffolded.files,
						defaultRole: res.scaffolded.defaultRole,
					},
				},
				`✔ scaffolded .warren/ in project ${args.projectId} (triggers.yaml + config.yaml)`,
			);
			return { exitCode: 0 };
		}

		const targetDir = resolveTargetDir({ cwd: args.cwd });
		const defaults = await resolveDefaults(deps, args);
		const result = await scaffoldWarrenConfig({ targetDir, defaults });

		writeResult(
			context,
			{
				ok: true,
				scaffolded: {
					root: targetDir,
					files: result.files,
					defaultRole: result.defaults.defaultRole ?? null,
				},
			},
			`✔ scaffolded .warren/ in ${targetDir} (triggers.yaml + config.yaml)`,
		);
		return { exitCode: 0 };
	} catch (err) {
		return commandFailure(context, err);
	}
}

async function resolveDefaults(deps: InitDeps, args: InitArgs): Promise<DefaultsConfig> {
	const candidate: Record<string, string> = {};
	const explicit = args.defaultRole;
	if (explicit !== undefined && explicit !== "") {
		const agent = await getAgentOrNull(deps.client, explicit);
		if (agent === null) {
			throw new ValidationError(`unknown agent: ${explicit}`, {
				recoveryHint: "register the agent on the server first, or omit --default-role",
			});
		}
		candidate.defaultRole = explicit;
	} else {
		// No explicit pick — auto-fill only when there's exactly one agent
		// registered. Multiple agents and we leave the field blank so the
		// operator picks at edit time (the schema accepts empty defaults).
		const { agents } = await deps.client.listAgents();
		if (agents.length === 1) {
			const only = agents[0];
			if (only !== undefined) {
				candidate.defaultRole = only.name;
			}
		}
	}

	const parsed = parseConfigFile(candidate);
	if (!parsed.ok) {
		// Should not happen — we only put fields the schema knows about —
		// but if it does, surface the schema message verbatim.
		throw new ValidationError(`config.yaml failed schema validation: ${parsed.message}`);
	}
	return parsed.value;
}

/** `GET /agents/:name`, mapping a 404 to null (unknown agent is a validation miss). */
async function getAgentOrNull(
	client: WarrenClient,
	name: string,
): Promise<{ readonly name: string } | null> {
	try {
		return await client.getAgent(name);
	} catch (err) {
		if (err instanceof WarrenClientError && err.status === 404) return null;
		throw err;
	}
}
