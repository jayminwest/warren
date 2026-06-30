/**
 * Loader for the per-project `.warren/` directory (R-02 + warren-5840 reorg).
 *
 * Contract (per pl-5d74 acceptance #2):
 *   missing file    → field is `null`, no entry in `errors`
 *   malformed file  → field is `null`, one entry in `errors`
 *   valid file      → field is the parsed value, no entry in `errors`
 *
 * Warren-5840 hoists global defaults into YAML and splits the preview block
 * into its own file. Backcompat precedence:
 *
 *   defaults: config.yaml > defaults.json (legacy)
 *   preview : preview.yaml > defaults.preview (from above)
 *
 * When a project still has `defaults.json` on disk — whether or not
 * `config.yaml` exists — the loader records a `warning` with code
 * `warren_config_deprecated` pointing operators at
 * `warren config migrate`. Warnings live in their own array so doctor /
 * readyz `warren_config` stays a clean errors-only check; a separate
 * `warren_config_deprecations` check aggregates the warnings for visibility
 * without flipping the project's health red.
 *
 * Filesystem failures specific to a single file (read EACCES, EISDIR) are
 * surfaced as parse errors so a half-broken `.warren/` never throws past
 * this module — operators see "what's wrong" in the same envelope the UI
 * and doctor render. Unrecoverable errors (project clone vanished entirely)
 * still throw `WarrenConfigUnavailableError`; that's a host-level problem,
 * not config drift.
 *
 * I/O is injected so tests don't touch disk and so tooling can swap to a
 * git-tree reader if `.warren/` ever needs to load from non-checked-out
 * refs. Defaults to `node:fs/promises` + `js-yaml`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { formatError } from "../core/errors.ts";
import { type PrTemplateOverrides, parsePrTemplate } from "../runs/pr-template.ts";
import { WARREN_CONFIG_DIR, WARREN_CONFIG_FILES, warrenConfigRelativePath } from "./config.ts";
import {
	WARREN_CONFIG_FILE_ERROR_CODES,
	type WarrenConfigFileError,
	WarrenConfigUnavailableError,
} from "./errors.ts";
import {
	type DefaultsConfig,
	parseConfigFile,
	parseDefaultsConfig,
	parsePreviewFile,
	parseTriggersConfig,
	type TriggersConfig,
} from "./schema.ts";

export interface LoadedWarrenConfig {
	/** Parsed triggers, or `null` when the file is absent or malformed. */
	readonly triggers: TriggersConfig | null;
	/**
	 * Parsed global defaults, or `null` when neither `config.yaml` nor
	 * legacy `defaults.json` exists (or both were malformed).
	 * `defaults.preview` is normalized to the effective preview block —
	 * `preview.yaml` takes precedence over any nested `preview` field
	 * (warren-5840).
	 */
	readonly defaults: DefaultsConfig | null;
	/**
	 * Per-fragment overrides parsed from `.warren/pr-template.md`
	 * (warren-bd49). `null` when the file is absent or its read failed;
	 * an empty object means the file exists but had no recognized
	 * fragments. Warnings (unknown fragment names, unclosed preview
	 * markers) surface via `errors` with `code: schemaError`.
	 */
	readonly prTemplate: PrTemplateOverrides | null;
	/**
	 * Relative path of the file the global defaults were loaded from
	 * (warren-489c, issue #486): `.warren/config.yaml` when it exists,
	 * else `.warren/defaults.json` when only the legacy file is present,
	 * else `null` when neither tier exists. Lets the API/UI render the
	 * dynamic config source instead of a hardcoded label.
	 */
	readonly sourceFile: string | null;
	/** Per-file failures collected during this load. Empty on full success. */
	readonly errors: readonly WarrenConfigFileError[];
	/**
	 * Non-fatal advisories collected during this load — e.g. the
	 * `defaults.json` deprecation warning (warren-5840). Doctor surfaces
	 * these as an informational `warren_config_deprecations` check so an
	 * operator sees them without flipping `warren_config` red.
	 */
	readonly warnings: readonly WarrenConfigFileError[];
}

export type ReadFileFn = (path: string) => Promise<string>;
export type ExistsFn = (path: string) => boolean;

export interface LoadWarrenConfigInput {
	/** Absolute path to the project clone root (NOT the `.warren/` dir). */
	readonly projectPath: string;
	readonly readFile?: ReadFileFn;
	readonly exists?: ExistsFn;
}

export async function loadWarrenConfig(input: LoadWarrenConfigInput): Promise<LoadedWarrenConfig> {
	const { projectPath } = input;
	const exists = input.exists ?? existsSync;
	const read = input.readFile ?? defaultReadFile;

	if (!exists(projectPath)) {
		// A project whose clone vanished is a data-integrity issue surfaced
		// by src/projects/refresh.ts — repeat the same error class so the HTTP
		// layer can map both to a 503 with the same recovery hint.
		throw new WarrenConfigUnavailableError(`project clone missing on disk: ${projectPath}`, {
			recoveryHint: "DELETE /projects/:id and POST /projects to re-clone",
		});
	}

	const dirPath = join(projectPath, WARREN_CONFIG_DIR);
	const errors: WarrenConfigFileError[] = [];
	const warnings: WarrenConfigFileError[] = [];

	if (!exists(dirPath)) {
		// No `.warren/` at all is the bootstrap shape — existing projects keep
		// working unchanged. All fields null, no errors or warnings.
		return {
			triggers: null,
			defaults: null,
			prTemplate: null,
			sourceFile: null,
			errors,
			warnings,
		};
	}

	const triggers = await loadTriggers({ projectPath, exists, read, errors });
	const defaults = await loadDefaults({ projectPath, exists, read, errors, warnings });
	const previewOverride = await loadPreviewFile({ projectPath, exists, read, errors });
	const prTemplate = await loadPrTemplate({ projectPath, exists, read, errors });

	const merged = mergePreviewOverride(defaults, previewOverride);
	const sourceFile = resolveDefaultsSourceFile({ projectPath, exists });
	return { triggers, defaults: merged, prTemplate, sourceFile, errors, warnings };
}

interface LoadOneInput {
	readonly projectPath: string;
	readonly exists: ExistsFn;
	readonly read: ReadFileFn;
	readonly errors: WarrenConfigFileError[];
}

interface LoadDefaultsInput extends LoadOneInput {
	readonly warnings: WarrenConfigFileError[];
}

async function loadTriggers(input: LoadOneInput): Promise<TriggersConfig | null> {
	const relPath = warrenConfigRelativePath("triggers");
	const absPath = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.triggers);

	if (!input.exists(absPath)) {
		return null;
	}

	let raw: string;
	try {
		raw = await input.read(absPath);
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `failed to read file: ${formatError(err)}`,
		});
		return null;
	}

	let document: unknown;
	try {
		document = yaml.load(raw, { filename: relPath });
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `YAML parse error: ${formatError(err)}`,
		});
		return null;
	}

	const result = parseTriggersConfig(document);
	if (!result.ok) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.schemaError,
			message: result.message,
		});
		return null;
	}
	return result.value;
}

/**
 * Resolve the global-defaults envelope. Precedence (warren-5840):
 *
 *   1. `config.yaml` — YAML, the canonical post-reorg home.
 *   2. `defaults.json` — JSON, legacy. Loading succeeds but the loader
 *      appends a `warren_config_deprecated` warning that names
 *      `warren config migrate` so doctor/UI can nudge operators.
 *
 * When both exist `config.yaml` wins, but the warning still fires so the
 * operator notices the stale legacy file. A malformed file in either tier
 * surfaces as an `errors[]` entry against that specific file and does NOT
 * roll over to the other tier — we want operators to see the parse / schema
 * failure rather than have it masked by a silent fallback.
 */
/**
 * Resolve which file the global defaults were (or would be) loaded from,
 * mirroring `loadDefaults`'s precedence: `config.yaml` wins, else the
 * legacy `defaults.json`, else `null`. Pure existence check — does not
 * read or parse — so a malformed file still reports its own source path.
 */
function resolveDefaultsSourceFile(input: {
	readonly projectPath: string;
	readonly exists: ExistsFn;
}): string | null {
	const configAbs = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.config);
	if (input.exists(configAbs)) {
		return warrenConfigRelativePath("config");
	}
	const defaultsAbs = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.defaults);
	if (input.exists(defaultsAbs)) {
		return warrenConfigRelativePath("defaults");
	}
	return null;
}

async function loadDefaults(input: LoadDefaultsInput): Promise<DefaultsConfig | null> {
	const configAbs = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.config);
	const defaultsAbs = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.defaults);
	const configExists = input.exists(configAbs);
	const defaultsExists = input.exists(defaultsAbs);

	if (defaultsExists) {
		input.warnings.push({
			file: warrenConfigRelativePath("defaults"),
			code: WARREN_CONFIG_FILE_ERROR_CODES.deprecated,
			message: configExists
				? "`.warren/defaults.json` is superseded by `.warren/config.yaml`; delete the legacy file"
				: "`.warren/defaults.json` is deprecated in favor of `.warren/config.yaml`; run `warren config migrate` to convert in place",
		});
	}

	if (configExists) {
		return loadConfigYaml(input, configAbs);
	}
	if (defaultsExists) {
		return loadLegacyDefaultsJson(input, defaultsAbs);
	}
	return null;
}

async function loadConfigYaml(
	input: LoadDefaultsInput,
	absPath: string,
): Promise<DefaultsConfig | null> {
	const relPath = warrenConfigRelativePath("config");
	let raw: string;
	try {
		raw = await input.read(absPath);
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `failed to read file: ${formatError(err)}`,
		});
		return null;
	}

	const trimmed = raw.trim();
	let document: unknown;
	if (trimmed === "") {
		document = undefined;
	} else {
		try {
			document = yaml.load(raw, { filename: relPath });
		} catch (err) {
			input.errors.push({
				file: relPath,
				code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
				message: `YAML parse error: ${formatError(err)}`,
			});
			return null;
		}
	}

	const result = parseConfigFile(document);
	if (!result.ok) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.schemaError,
			message: result.message,
		});
		return null;
	}
	return result.value;
}

async function loadLegacyDefaultsJson(
	input: LoadDefaultsInput,
	absPath: string,
): Promise<DefaultsConfig | null> {
	const relPath = warrenConfigRelativePath("defaults");
	let raw: string;
	try {
		raw = await input.read(absPath);
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `failed to read file: ${formatError(err)}`,
		});
		return null;
	}

	const trimmed = raw.trim();
	let document: unknown;
	if (trimmed === "") {
		document = undefined;
	} else {
		try {
			document = JSON.parse(raw);
		} catch (err) {
			input.errors.push({
				file: relPath,
				code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
				message: `JSON parse error: ${formatError(err)}`,
			});
			return null;
		}
	}

	const result = parseDefaultsConfig(document);
	if (!result.ok) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.schemaError,
			message: result.message,
		});
		return null;
	}
	return result.value;
}

/**
 * Load the standalone `.warren/preview.yaml` (warren-5840). Returns the
 * parsed `PreviewConfig` on success or `null` when the file is absent.
 * Malformed content surfaces via `errors[]`; on schema failure the override
 * is treated as absent so the loader falls back to the nested preview field
 * inside config.yaml / defaults.json rather than silently shipping a half-
 * parsed value.
 */
async function loadPreviewFile(input: LoadOneInput): Promise<DefaultsConfig["preview"] | null> {
	const relPath = warrenConfigRelativePath("preview");
	const absPath = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.preview);

	if (!input.exists(absPath)) {
		return null;
	}

	let raw: string;
	try {
		raw = await input.read(absPath);
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `failed to read file: ${formatError(err)}`,
		});
		return null;
	}

	const trimmed = raw.trim();
	let document: unknown;
	if (trimmed === "") {
		document = undefined;
	} else {
		try {
			document = yaml.load(raw, { filename: relPath });
		} catch (err) {
			input.errors.push({
				file: relPath,
				code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
				message: `YAML parse error: ${formatError(err)}`,
			});
			return null;
		}
	}

	const result = parsePreviewFile(document);
	if (!result.ok) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.schemaError,
			message: result.message,
		});
		return null;
	}
	return result.value;
}

/**
 * Fold a `preview.yaml` override (if any) into the defaults envelope.
 * `preview.yaml` wins over any nested `preview` field. If the operator
 * shipped only `preview.yaml` (no config.yaml / defaults.json), we
 * synthesize a defaults envelope with just `preview` populated so
 * downstream consumers can keep reading `defaults?.preview`.
 */
function mergePreviewOverride(
	defaults: DefaultsConfig | null,
	override: DefaultsConfig["preview"] | null,
): DefaultsConfig | null {
	if (override === null) {
		return defaults;
	}
	if (defaults === null) {
		return { preview: override };
	}
	return { ...defaults, preview: override };
}

async function loadPrTemplate(input: LoadOneInput): Promise<PrTemplateOverrides | null> {
	const relPath = warrenConfigRelativePath("prTemplate");
	const absPath = join(input.projectPath, WARREN_CONFIG_DIR, WARREN_CONFIG_FILES.prTemplate);

	if (!input.exists(absPath)) {
		return null;
	}

	let raw: string;
	try {
		raw = await input.read(absPath);
	} catch (err) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.parseError,
			message: `failed to read file: ${formatError(err)}`,
		});
		return null;
	}

	const parsed = parsePrTemplate(raw);
	for (const warning of parsed.warnings) {
		input.errors.push({
			file: relPath,
			code: WARREN_CONFIG_FILE_ERROR_CODES.schemaError,
			message: warning.message,
		});
	}
	return parsed.overrides;
}

function defaultReadFile(path: string): Promise<string> {
	return readFile(path, "utf8");
}
