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
 *                        commit + push themselves.
 *   `--project <id>`     scaffolds into the warren clone at
 *                        `<projects-root>/.../<repo>`. Useful for
 *                        warren-on-warren and other in-container flows;
 *                        operator still owns the commit + push (e.g. via
 *                        the project repo upstream).
 *
 * No git side-effects: this is intentionally a write-and-stop. The
 * heavier UI variant (B) in warren-bd22 — commit + push from warren's
 * service identity — is deferred until warren has a sanctioned
 * project-repo write path beyond `git push` from reap.
 *
 * Refuses to overwrite either file, including the legacy
 * `.warren/defaults.json` left over from a pre-warren-5840 install — that
 * file should be migrated via `warren config migrate` before scaffolding.
 * Schema is enforced at scaffold time via `parseConfigFile` so a malformed
 * defaults blob is impossible to write.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump } from "js-yaml";
import { type WarrenClient, WarrenClientError } from "../../client/index.ts";
import { ValidationError } from "../../core/errors.ts";
import {
	WARREN_CONFIG_DIR,
	WARREN_CONFIG_FILES,
	warrenConfigRelativePath,
} from "../../warren-config/config.ts";
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
	 * Remote warren client (warren-97a2). `--project` resolves the clone
	 * path via `GET /projects/:id`; `--default-role` validates against
	 * `GET /agents/:name`. The CLI no longer opens the server's DB.
	 */
	readonly client: WarrenClient;
}

export interface InitResult {
	readonly exitCode: number;
}

/**
 * Canonical header for the empty triggers.yaml — short enough to read at
 * a glance, long enough to point operators at the schema. Keep this in
 * lockstep with `src/warren-config/schema.ts` if/when new trigger kinds
 * ship.
 */
const TRIGGERS_TEMPLATE = `# .warren/triggers.yaml — scheduled runs for this project (R-06).
#
# Each entry is a cron-style trigger. Warren ticks once a minute and
# spawns a run when a trigger is due. See docs/design/scheduler.md for the contract.
#
# Example:
# - id: nightly-housekeeping
#   kind: cron
#   cron: '0 3 * * *'      # 03:00 daily (5 or 6 whitespace-separated fields)
#   seed: warren-housekeep # seed id the agent reads + writes
#   role: claude-code      # registered agent name
#   timezone: UTC          # optional; default UTC
#   prompt: |              # optional; pre-filled into the agent
#     Run the housekeeping checklist.
[]
`;

const CONFIG_HEADER = `# .warren/config.yaml — per-project warren defaults (warren-5840 layout).
#
# Supersedes the legacy .warren/defaults.json. Fields are all optional;
# every key from the JSON layout works here unchanged. See
# docs/design/warren-config.md for the schema. Moving from defaults.json? Run \`warren config migrate\`.
`;

export async function runInit(
	context: CliContext,
	deps: InitDeps,
	args: InitArgs,
): Promise<InitResult> {
	try {
		const targetDir = await resolveTargetDir(deps.client, args);
		const warrenDir = join(targetDir, WARREN_CONFIG_DIR);
		const triggersAbs = join(warrenDir, WARREN_CONFIG_FILES.triggers);
		const configAbs = join(warrenDir, WARREN_CONFIG_FILES.config);
		const legacyDefaultsAbs = join(warrenDir, WARREN_CONFIG_FILES.defaults);

		if (existsSync(triggersAbs)) {
			throw new ValidationError(
				`refusing to overwrite existing ${warrenConfigRelativePath("triggers")} at ${triggersAbs}`,
				{ recoveryHint: "edit the existing file by hand" },
			);
		}
		if (existsSync(configAbs)) {
			throw new ValidationError(
				`refusing to overwrite existing ${warrenConfigRelativePath("config")} at ${configAbs}`,
				{ recoveryHint: "edit the existing file by hand" },
			);
		}
		if (existsSync(legacyDefaultsAbs)) {
			throw new ValidationError(
				`refusing to scaffold over legacy ${warrenConfigRelativePath("defaults")} at ${legacyDefaultsAbs}`,
				{
					recoveryHint: "run `warren config migrate` to convert defaults.json into config.yaml",
				},
			);
		}

		const defaults = await resolveDefaults(deps, args);
		const configYaml = `${CONFIG_HEADER}${renderConfigYaml(defaults)}`;

		await mkdir(warrenDir, { recursive: true });
		await writeFile(triggersAbs, TRIGGERS_TEMPLATE, "utf8");
		await writeFile(configAbs, configYaml, "utf8");

		writeResult(
			context,
			{
				ok: true,
				scaffolded: {
					root: targetDir,
					files: [warrenConfigRelativePath("triggers"), warrenConfigRelativePath("config")],
					defaultRole: defaults.defaultRole ?? null,
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

/**
 * Render `DefaultsConfig` into the scaffolded YAML body. Empty objects
 * render as `{}` rather than the empty string so the file always
 * round-trips through `load` to the same schema-valid value.
 */
function renderConfigYaml(defaults: DefaultsConfig): string {
	if (Object.keys(defaults).length === 0) {
		return "{}\n";
	}
	return dump(defaults, { lineWidth: 100, noRefs: true });
}
