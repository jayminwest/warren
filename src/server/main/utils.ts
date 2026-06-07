/**
 * Small env/process/db helpers used by `bootServer` (warren-8d3d /
 * pl-9088 step 10). Kept in a sibling module so the orchestrator in
 * `index.ts` stays under the 500-line per-file budget.
 */

import { type AnyWarrenDb, WARREN_DB_POOL_MAX_ENV } from "../../db/client.ts";
import { parseDatabaseUrl } from "../../db/url.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../../projects/clone.ts";
import type { EnvLike } from "../config.ts";

/**
 * Production `Bun.spawn` adaptor matching the SpawnFn shape the registry +
 * projects modules expect. One of three identical copies, alongside
 * `defaultSpawn` in src/cli/output.ts and src/server/handlers/index.ts;
 * the duplication is deliberate so neither surface imports the other.
 */
export const defaultSpawn: SpawnFn = async (
	cmd: readonly string[],
	opts: SpawnOptions,
): Promise<SpawnResult> => {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer =
		opts.timeoutMs !== undefined && opts.timeoutMs > 0
			? setTimeout(() => proc.kill(), opts.timeoutMs)
			: null;
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (timer !== null) clearTimeout(timer);
	return { stdout, stderr, exitCode: exitCode ?? 0 };
};

export async function closeDatabase(db: AnyWarrenDb): Promise<void> {
	try {
		await db.close();
	} catch {
		// Closing twice during a panicked shutdown is fine.
	}
}

/**
 * Read `WARREN_DB_POOL_MAX` (pg pool max). Undefined / blank → use the
 * `openDatabase` default. The pool size only matters on the postgres
 * branch; the sqlite branch ignores it.
 */
export function resolvePgPoolMax(env: EnvLike): number | undefined {
	return parseIntEnv(env, WARREN_DB_POOL_MAX_ENV, undefined);
}

/**
 * Strip the userinfo (`user:password@`) from a postgres URL before
 * logging. sqlite URLs and bare sentinels pass through unchanged.
 * Defensive: any URL-parse failure falls back to the dialect-and-scheme
 * shorthand so a malformed URL never leaks creds into the log.
 */
export function redactDbUrl(url: string): string {
	const parsed = parseDatabaseUrl(url);
	if (parsed.dialect === "sqlite") return url;
	try {
		const u = new URL(parsed.connectionString);
		if (u.username !== "" || u.password !== "") {
			u.username = "";
			u.password = "";
			return u.toString();
		}
		return parsed.connectionString;
	} catch {
		return "postgres://<unparseable>";
	}
}

export function parseTrueEnv(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const t = raw.trim().toLowerCase();
	return t === "1" || t === "true" || t === "yes";
}

export function parseIntEnv<F extends number | undefined>(
	env: EnvLike,
	name: string,
	fallback: F,
): number | F {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
		throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
	}
	return n;
}
