/**
 * One-off `tool_calls` corpus repair (warren-677c).
 *
 * Pi `toolCall` blocks wrap their args as `{"arguments":{"command":…}}`,
 * but the pi tool/file shapes read only `input`/top-level fields, so
 * every pi bash row landed `command=NULL` and every pi edit/read/write
 * row landed empty `file_paths`. The shapes are fixed; this script
 * re-extracts the damaged rows from retained `events` payloads by
 * running `repairToolCallRollup` — delete-and-replay per run, through
 * the same extraction seam the live bridge uses. Runs whose events were
 * pruned are skipped, never deleted.
 *
 * Idempotent: re-extracting an already-correct run rewrites identical
 * rows, so a re-run (or a run that races the live bridge) is safe.
 *
 * Usage:
 *   WARREN_DB_URL=postgres://... bun run scripts/repair-tool-calls.ts
 *   WARREN_DB_URL=... bun run scripts/repair-tool-calls.ts --dry-run
 *
 * `WARREN_DB_URL` is deliberately required with no default — this
 * script rewrites rollup rows in whatever database it is pointed at,
 * and a default would eventually point it at the wrong one by accident.
 * `--dry-run` only counts the runs the walk would re-extract.
 */

import { openDatabase } from "../src/db/client.ts";
import { createRepos } from "../src/db/repos/index.ts";
import { repairToolCallRollup } from "../src/runs/tool-calls-backfill.ts";

export interface Args {
	readonly dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
	return { dryRun: argv.includes("--dry-run") };
}

/** The explicit-target contract: no url, no run. Returns the url or throws. */
export function requireDbUrl(env: Record<string, string | undefined>): string {
	const url = env.WARREN_DB_URL?.trim();
	if (url === undefined || url === "") {
		throw new Error(
			"WARREN_DB_URL is required (no default): point it at the database whose tool_calls rollup you want repaired",
		);
	}
	return url;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const url = requireDbUrl(process.env);
	const db = await openDatabase({ url, skipMigrations: true });
	try {
		const repos = createRepos(db);
		if (args.dryRun) {
			let count = 0;
			let afterRunId: string | undefined;
			for (;;) {
				const page = await repos.toolCalls.listRunsWithRollup({
					limit: 500,
					...(afterRunId === undefined ? {} : { afterRunId }),
				});
				if (page.length === 0) break;
				count += page.length;
				afterRunId = page[page.length - 1];
			}
			console.log(`dry-run: ${count} run(s) with rollup rows would be re-extracted`);
			return;
		}
		const result = await repairToolCallRollup(repos, {
			logger: {
				info: (obj, msg) => console.log(msg, JSON.stringify(obj)),
				warn: (obj, msg) => console.warn(msg, JSON.stringify(obj)),
			},
		});
		console.log(
			`repaired ${result.runs} run(s) (${result.uses} tool_use rows, ${result.results} result joins), skipped ${result.skipped}`,
		);
	} finally {
		await db.close();
	}
}

if (import.meta.main) {
	await main();
}
