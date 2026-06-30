/**
 * Loader for warren's server-level TOML config
 * (pl-9ba1 step 7 / warren-3909; `[workers]` validation added in step 8
 * / warren-272c).
 *
 * Contract:
 *   WARREN_CONFIG_FILE unset  → empty config; identical to env-only boot.
 *   path set, file missing    → `ValidationError` (operator misconfig).
 *   file empty                → empty config (Bun.TOML.parse("") returns {}).
 *   malformed TOML            → `ValidationError` with parse-error detail.
 *   schema rejection          → `ValidationError` with field-level detail.
 *   invalid [workers] entry   → `ValidationError` with `workers[i].field` path.
 *   valid file                → parsed `WarrenServerFileConfig` plus the
 *                               post-validated `workers: ParsedWorkerEntry[]`
 *                               (empty array when no `[[workers]]` block).
 *
 * I/O is injected so tests don't touch disk and so the boot path can
 * swap to a different reader if `warren.toml` ever needs to load from
 * a non-disk source (e.g. a k8s ConfigMap mount where atomic-swap
 * semantics matter). Defaults to `node:fs/promises` + `Bun.TOML.parse`.
 *
 * The loader does NOT merge with env vars — the merge precedence
 * (operator override > file > built-in) is per-consumer and lives next
 * to the consumer. The `BURROW_API_TOKEN` requirement when `[workers]`
 * is non-empty (acceptance #8) is enforced at boot via
 * `requireSharedBurrowToken` (workers.ts), not here — the loader's job
 * is to surface what the file says, not to gate on env vars.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { formatError, ValidationError } from "../core/errors.ts";
import { type EnvLike, resolveWarrenConfigFilePath, WARREN_CONFIG_FILE_ENV } from "./config.ts";
import { parseWarrenServerFileConfig, type WarrenServerFileConfig } from "./schema.ts";
import { type ParsedWorkerEntry, validateWorkerEntries } from "./workers.ts";

export type ReadFileFn = (path: string) => Promise<string>;
export type ExistsFn = (path: string) => boolean;

export interface LoadWarrenServerConfigInput {
	/** Explicit path; overrides the env-var lookup when provided. */
	readonly path?: string;
	/** Defaults to `process.env`. */
	readonly env?: EnvLike;
	readonly readFile?: ReadFileFn;
	readonly exists?: ExistsFn;
}

export interface LoadedWarrenServerConfig {
	/** Absolute path the loader read from, or `null` for the no-file path. */
	readonly path: string | null;
	readonly config: WarrenServerFileConfig;
	/**
	 * Post-validation `[workers]` entries with parsed transports. Empty
	 * array when no `[[workers]]` block was declared — the boot path
	 * uses `workers.length > 0` to decide between `BurrowClientPool.
	 * fromConfig` (file-driven) and `fromEnv` (zero-config back-compat).
	 */
	readonly workers: readonly ParsedWorkerEntry[];
}

export async function loadWarrenServerConfigFromFile(
	input: LoadWarrenServerConfigInput = {},
): Promise<LoadedWarrenServerConfig> {
	const env = input.env ?? process.env;
	const exists = input.exists ?? existsSync;
	const read = input.readFile ?? defaultReadFile;

	const path = input.path ?? resolveWarrenConfigFilePath(env);
	if (path === null || path === "") {
		return { path: null, config: {}, workers: [] };
	}

	if (!exists(path)) {
		throw new ValidationError(
			`${WARREN_CONFIG_FILE_ENV} points at a file that does not exist: ${path}`,
			{
				recoveryHint: `create ${path} (an empty file is valid) or unset ${WARREN_CONFIG_FILE_ENV}`,
			},
		);
	}

	let raw: string;
	try {
		raw = await read(path);
	} catch (err) {
		throw new ValidationError(`failed to read ${path}: ${formatError(err)}`, {
			recoveryHint: `check filesystem permissions on ${path}`,
			cause: err,
		});
	}

	let document: unknown;
	try {
		document = Bun.TOML.parse(raw);
	} catch (err) {
		throw new ValidationError(`failed to parse ${path} as TOML: ${formatError(err)}`, {
			recoveryHint: `fix the TOML syntax in ${path}; run \`bun -e 'Bun.TOML.parse(require("fs").readFileSync("${path}", "utf8"))'\` to reproduce`,
			cause: err,
		});
	}

	const result = parseWarrenServerFileConfig(document);
	if (!result.ok) {
		throw new ValidationError(`invalid config in ${path}: ${result.message}`, {
			recoveryHint: `fix the offending field(s) in ${path}`,
		});
	}

	const validatedWorkers = validateWorkerEntries(result.value.workers ?? []);
	if (!validatedWorkers.ok) {
		throw new ValidationError(`invalid config in ${path}: ${validatedWorkers.message}`, {
			recoveryHint: `fix the offending [[workers]] entry in ${path}`,
		});
	}

	return { path, config: result.value, workers: validatedWorkers.workers };
}

function defaultReadFile(path: string): Promise<string> {
	return readFile(path, "utf8");
}
