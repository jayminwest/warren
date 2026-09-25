/**
 * Canonical `.warren/` scaffolding for a project clone (warren-166d).
 *
 * One implementation of "write a schema-valid `triggers.yaml` +
 * `config.yaml` skeleton into a directory", shared by the two surfaces
 * that need it: the `POST /projects/:id/init` handler (which writes
 * into the server-side host clone so a remote CLI can scaffold a
 * project it cannot see on disk) and `warren init --cwd` (which writes
 * into the operator's local checkout). Before warren-166d the template
 * and render logic lived in `src/cli/commands/init.ts`, which made the
 * server-side route impossible without a second copy.
 *
 * No git side-effects: this is intentionally a write-and-stop. The
 * operator still owns committing the files (or, for the host clone,
 * leaving them untracked — `refreshProjectClone` never runs
 * `git clean`, so untracked `.warren/` files survive every refresh).
 *
 * Refuses to overwrite either file, including the legacy
 * `.warren/defaults.json` left over from a pre-warren-5840 install — that
 * file should be migrated via `warren config migrate` before scaffolding.
 * `overwrite: true` (the server route's escape hatch) skips all three
 * existence refusals. Schema is enforced at scaffold time via
 * `parseConfigFile` so a malformed defaults blob is impossible to write.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump } from "js-yaml";
import { ValidationError } from "../core/errors.ts";
import {
	WARREN_CONFIG_DIR,
	WARREN_CONFIG_FILES,
	warrenConfigRelativePath,
} from "../warren-config/config.ts";
import { type DefaultsConfig, parseConfigFile } from "../warren-config/schema.ts";

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

export interface ScaffoldWarrenConfigInput {
	/** Directory to scaffold `.warren/` into (a project clone root). */
	readonly targetDir: string;
	/**
	 * Raw defaults fields for the scaffolded `config.yaml`. Validated
	 * through `parseConfigFile` here — the one construction site — so a
	 * malformed blob is impossible to write from any surface.
	 */
	readonly defaults?: unknown;
	/**
	 * Skip the three existence refusals (triggers.yaml, config.yaml,
	 * legacy defaults.json) and write over whatever is there. The server
	 * route's escape hatch; the CLI never passes it today.
	 */
	readonly overwrite?: boolean;
}

export interface ScaffoldWarrenConfigResult {
	/** Project-relative paths of the files written, in write order. */
	readonly files: string[];
	/** The schema-valid defaults the config.yaml carries. */
	readonly defaults: DefaultsConfig;
}

/**
 * Scaffold `.warren/triggers.yaml` + `.warren/config.yaml` into
 * `targetDir`. Throws `ValidationError` when either file (or the legacy
 * `defaults.json`) already exists and `overwrite` is not set, or when
 * `defaults` fails schema validation.
 */
export async function scaffoldWarrenConfig(
	input: ScaffoldWarrenConfigInput,
): Promise<ScaffoldWarrenConfigResult> {
	const warrenDir = join(input.targetDir, WARREN_CONFIG_DIR);
	const triggersAbs = join(warrenDir, WARREN_CONFIG_FILES.triggers);
	const configAbs = join(warrenDir, WARREN_CONFIG_FILES.config);
	const legacyDefaultsAbs = join(warrenDir, WARREN_CONFIG_FILES.defaults);

	if (input.overwrite !== true) {
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
	}

	const parsed = parseConfigFile(input.defaults ?? {});
	if (!parsed.ok) {
		// Only fields the schema knows about may reach the file — surface
		// the schema message verbatim so the caller knows which one failed.
		throw new ValidationError(`config.yaml failed schema validation: ${parsed.message}`);
	}
	const defaults = parsed.value;
	const configYaml = `${CONFIG_HEADER}${renderConfigYaml(defaults)}`;

	await mkdir(warrenDir, { recursive: true });
	await writeFile(triggersAbs, TRIGGERS_TEMPLATE, "utf8");
	await writeFile(configAbs, configYaml, "utf8");

	return {
		files: [warrenConfigRelativePath("triggers"), warrenConfigRelativePath("config")],
		defaults,
	};
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
