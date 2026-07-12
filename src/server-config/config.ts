/**
 * Path resolution for warren's server-level TOML config file
 * (pl-9ba1 step 7 / warren-3909).
 *
 * Distinct from `src/warren-config/` (which loads per-PROJECT `.warren/`
 * directories from each cloned repo) and from `src/server/config.ts`
 * (which reads the warren server's own env vars). This module owns the
 * operator-facing config FILE that lives next to the warren deployment
 * — `warren.toml`. The schema is empty today: the `[[workers]]` block it
 * once carried was retired with the K8s migration (warren-288f). The
 * loader scaffolding is kept so a future top-level key can grow the
 * schema without re-plumbing the boot path.
 *
 * No default path: V1 ships zero-config-back-compat (parent plan
 * acceptance #1), so a warren deploy with `WARREN_CONFIG_FILE` unset
 * behaves identically to today. Setting the env var is the opt-in.
 */

export const WARREN_CONFIG_FILE_ENV = "WARREN_CONFIG_FILE";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the operator-configured path to `warren.toml`, or `null` if
 * the env var is unset / empty. Returns the raw string verbatim — the
 * loader is responsible for resolving relative paths against its own
 * working directory if it cares to.
 */
export function resolveWarrenConfigFilePath(env: EnvLike): string | null {
	const raw = env[WARREN_CONFIG_FILE_ENV];
	if (raw === undefined || raw === "") return null;
	return raw;
}
