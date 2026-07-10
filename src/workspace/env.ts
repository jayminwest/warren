/**
 * Resolve a project's `[env]` + `[secrets]` config → a concrete env map for the
 * workspace/sandbox profile.
 *
 * Resolution order, per key (highest → lowest):
 *   1. CLI overrides passed via `overrides`.
 *   2. `[secrets]` literal or `op://...` (resolved via OpResolver).
 *   3. User secret store (`global.env` then `<project>.env`, project wins).
 *   4. Host process env (only for keys named in `[env].required` /
 *      `[env].optional`, so we don't accidentally bleed unrelated host vars).
 *   5. `[env].defaults`.
 *
 * Rules:
 *   - Every key in `[env].required` must resolve to a non-empty value or we
 *     throw `SecretResolutionError`.
 *   - Optional keys missing everywhere are silently dropped.
 *   - `[secrets]` literals starting with `op://` are routed to the resolver;
 *     anything else is taken as a literal string.
 *
 * Extracted from burrow's `src/secrets/env.ts` (behavior-identical) into
 * warren's workspace cluster. Two adaptations: the error class now comes from
 * `src/workspace/errors.ts`, and the config shape is a neutral structural type
 * (`WorkspaceEnvConfig`) covering only the fields this function reads — rather
 * than importing burrow's `BurrowToml` schema. See
 * `docs/design/k8s-migration-plan.md` §5.A. No burrow-repo imports.
 */

import { SecretResolutionError } from "./errors.ts";
import { OpResolver } from "./op.ts";

/**
 * Minimal structural view of a project's env/secrets config — the only slice of
 * the underlying config file (`burrow.toml`, `.warren/...`, etc.) that
 * `resolveEnv` actually reads. Deliberately neutral so the workspace cluster
 * doesn't depend on any one tool's config schema.
 */
export interface WorkspaceEnvConfig {
	env?: {
		/** Keys that must resolve to a non-empty value, else we throw. */
		required?: string[];
		/** Keys pulled from host/store/secrets if present, dropped if absent. */
		optional?: string[];
		/** Lowest-precedence fallback values. */
		defaults?: Record<string, string>;
	};
	/** `KEY → literal | op://...` map. `op://` refs go through the resolver. */
	secrets?: Record<string, string>;
}

export interface ResolveEnvInput {
	config: WorkspaceEnvConfig | null;
	/** Merged secrets-store map (output of `loadSecretStore({...}).merged`). */
	secretsStore?: Record<string, string>;
	/** Host process env. Tests pass a minimal map; CLI passes `process.env`. */
	hostEnv?: Record<string, string | undefined>;
	/** CLI-flag overrides. Win over everything else. */
	overrides?: Record<string, string>;
	/** Inject a custom OpResolver (or fake) for tests. */
	op?: OpResolver;
}

export interface ResolveEnvResult {
	/** Final resolved KEY → value map. Empty strings excluded. */
	values: Record<string, string>;
	/** Keys that were declared in [env].required + actually resolved. */
	requiredResolved: string[];
	/** Keys that were declared in [env].optional and resolved. */
	optionalResolved: string[];
	/** [env].optional keys that were missing everywhere (informational). */
	optionalMissing: string[];
}

/**
 * Layers 5→3: defaults (lowest), then host env for declared keys only, then the
 * already-merged secrets store. Mutates `values` in place.
 */
function applyBaseLayers(
	values: Record<string, string>,
	opts: {
		defaults: Record<string, string>;
		hostEnvKeys: Set<string>;
		hostEnv: Record<string, string | undefined>;
		store: Record<string, string>;
	},
): void {
	// Layer 5: defaults (lowest precedence, applied first).
	for (const [k, v] of Object.entries(opts.defaults)) {
		if (v.length > 0) values[k] = v;
	}
	// Layer 4: host env — only for declared required/optional keys. We never
	// copy unrelated host vars into the workspace.
	for (const k of opts.hostEnvKeys) {
		const hv = opts.hostEnv[k];
		if (typeof hv === "string" && hv.length > 0) values[k] = hv;
	}
	// Layer 3: secrets store (global + project, already merged).
	for (const [k, v] of Object.entries(opts.store)) {
		if (v.length > 0) values[k] = v;
	}
}

/**
 * Layer 2: the `[secrets]` block — literals stored as-is, `op://` refs routed
 * through the resolver. Mutates `values`; returns the list of op-lookup error
 * messages (empty on full success) so the caller decides whether to throw.
 */
async function applySecrets(
	values: Record<string, string>,
	secrets: Record<string, string>,
	op: OpResolver,
): Promise<string[]> {
	const opErrors: string[] = [];
	for (const [k, raw] of Object.entries(secrets)) {
		if (OpResolver.isOpRef(raw)) {
			try {
				const v = await op.resolve(k, raw);
				if (v.length > 0) values[k] = v;
			} catch (err) {
				opErrors.push(err instanceof Error ? err.message : String(err));
			}
		} else if (raw.length > 0) {
			values[k] = raw;
		}
	}
	return opErrors;
}

/**
 * Layer 1: CLI overrides (highest). An empty string clears the entry, letting
 * users blank out a default at the CLI without editing the file.
 */
function applyOverrides(values: Record<string, string>, overrides: Record<string, string>): void {
	for (const [k, v] of Object.entries(overrides)) {
		if (v.length === 0) {
			delete values[k];
		} else {
			values[k] = v;
		}
	}
}

/**
 * Resolve environment + secrets. Throws `SecretResolutionError` if any
 * required key is missing OR an `op://` lookup fails.
 */
export async function resolveEnv(input: ResolveEnvInput): Promise<ResolveEnvResult> {
	const config = input.config ?? null;
	const secrets = config?.secrets ?? {};
	const envSpec = config?.env ?? {};
	const required = envSpec.required ?? [];
	const optional = envSpec.optional ?? [];
	const op = input.op ?? new OpResolver();

	const values: Record<string, string> = {};

	applyBaseLayers(values, {
		defaults: envSpec.defaults ?? {},
		// Keys we actively pull from host env — declared required/optional only.
		hostEnvKeys: new Set<string>([...required, ...optional]),
		hostEnv: input.hostEnv ?? {},
		store: input.secretsStore ?? {},
	});

	const opErrors = await applySecrets(values, secrets, op);
	if (opErrors.length > 0) {
		throw new SecretResolutionError(
			`failed to resolve ${opErrors.length} secret reference(s):\n  ${opErrors.join("\n  ")}`,
			{ recoveryHint: "install `op` or remove the op:// entry" },
		);
	}

	applyOverrides(values, input.overrides ?? {});

	// Required-key gate. Missing required keys collected into one error.
	const missingRequired = required.filter((k) => !(k in values) || values[k]?.length === 0);
	if (missingRequired.length > 0) {
		throw new SecretResolutionError(
			`required env variable(s) not resolved: ${missingRequired.join(", ")}`,
			{
				recoveryHint:
					"set them in [env.defaults], [secrets], the user secrets file under configDir/secrets/<project>.env, or the host shell",
			},
		);
	}

	const requiredResolved = required.filter((k) => k in values);
	const optionalResolved = optional.filter((k) => k in values);
	const optionalMissing = optional.filter((k) => !(k in values));

	return { values, requiredResolved, optionalResolved, optionalMissing };
}
