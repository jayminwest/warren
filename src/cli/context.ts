/**
 * `withCliDb` — open the warren DB, build a Repos handle, run the body,
 * and close the DB on exit (success or failure).
 *
 * Post-warren-97a2 (owner decision D3) the only remaining consumer is
 * `doctor --local`, the deployment-side half of doctor, which opens via
 * `withCliDb` so its `db_reachable` check can probe the live handle.
 * Every remote-capable command (`run`, `add-project`, `init`,
 * `config migrate`, the `plan` group) drives the server through the
 * WarrenClient SDK instead — see `src/cli/client.ts`.
 *
 * The DB URL resolves the same way `bootServer` resolves it (see
 * `server/config.ts`): explicit `WARREN_DB_URL`, else `WARREN_DB_PATH`
 * synthesized to a `sqlite://` URL, else `<DATA_DIR>/warren.db`
 * synthesized. The CLI is meant to run alongside `warren serve` inside
 * the same container, so the default lands on the supervised data
 * volume without extra config.
 */

import { join } from "node:path";
import { type AnyWarrenDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { sqliteUrlForPath } from "../db/url.ts";
import type { EnvLike } from "./output.ts";

export const DEFAULT_DATA_DIR = "/data";

export interface ResolvedDbUrl {
	readonly url: string;
	/**
	 * Carries the legacy WARREN_DB_PATH value when an explicit
	 * WARREN_DB_URL disagrees with it. CLI commands surface a stderr
	 * warning so the operator notices the mismatch.
	 */
	readonly conflict: string | null;
}

export function resolveDbUrl(env: EnvLike): ResolvedDbUrl {
	const url = env.WARREN_DB_URL;
	const path = env.WARREN_DB_PATH;
	if (url !== undefined && url !== "") {
		const conflict =
			path !== undefined && path !== "" && sqliteUrlForPath(path) !== url ? path : null;
		return { url, conflict };
	}
	if (path !== undefined && path !== "") {
		return { url: sqliteUrlForPath(path), conflict: null };
	}
	const dataDir = env.WARREN_DATA_DIR ?? DEFAULT_DATA_DIR;
	return { url: sqliteUrlForPath(join(dataDir, "warren.db")), conflict: null };
}

export interface WithCliDbInput {
	readonly env: EnvLike;
	/** Override the DB URL (tests pass `:memory:`). */
	readonly dbUrl?: string;
}

export async function withCliDb<T>(
	input: WithCliDbInput,
	fn: (handle: { db: AnyWarrenDb; repos: Repos }) => Promise<T>,
): Promise<T> {
	const url = input.dbUrl ?? resolveDbUrl(input.env).url;
	const db = await openDatabase({ url });
	const repos = createRepos(db);
	try {
		return await fn({ db, repos });
	} finally {
		try {
			await db.close();
		} catch {
			// Closing twice during a panicked teardown is fine.
		}
	}
}
