/**
 * Scenario 19 — warren-on-postgres end-to-end (R-13, pl-f17e step 7).
 *
 * Acceptance criterion #4 of pl-f17e:
 *   "warren-on-postgres dispatches a run end-to-end against a Postgres
 *   container, streams events, restarts warren mid-stream, and verifies
 *   event resume from MAX(events.burrow_event_seq)+1 works the same as
 *   on SQLite (docs/design/runtime-and-supervisor.md restart-recovery contract)."
 *
 * This is the structural twin of scenario 06 (restart-recovery) — the
 * difference is the backend warren writes its rows to. Scenario 06 runs
 * against the harness's default sqlite handle; scenario 19 stands up an
 * isolated Postgres database, points a fresh warren+burrow at it via
 * WARREN_DB_URL, then exercises the same kill-mid-stream / restart /
 * resume contract.
 *
 * ## Substrate decision (deviating from withDb in src/db/testing.ts)
 *
 * withDb() (mx-73932c) uses per-test schemas + drizzle's `migrationsSchema`
 * option so DROP SCHEMA CASCADE reclaims both the tables and the
 * `__drizzle_migrations` bookkeeping. That works for unit tests because
 * the test process opens drizzle itself and threads the option through.
 *
 * Scenario 19 spawns warren as a subprocess; warren's `openDatabase` does
 * NOT thread `migrationsSchema` (today; production has no need). If we
 * isolated by search_path only, drizzle would write its journal to the
 * default `drizzle` schema and skip migrations on the next scenario run
 * (the journal hashes would already match) — yielding empty per-scenario
 * schemas and a broken warren boot. Rather than widen warren's openDatabase
 * surface for a test concern, we provision a **fresh database** per
 * scenario via a maintenance connection on the base URL, point warren at
 * that database, and DROP it on teardown. Warren's migrations run cleanly
 * inside the new database, including the `drizzle.__drizzle_migrations`
 * bookkeeping which is dropped along with the database.
 *
 * Requires `WARREN_TEST_PG_URL` to be set (same env contract as the
 * pg unit-test substrate, mx-c1cd3a). The user the URL authenticates as
 * must hold CREATEDB. Skip-gated via `ScenarioSkipped` when unset so the
 * default `bun run scripts/acceptance/run.ts` invocation stays green on
 * a stock machine while CI matrix jobs that opt in light it up.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
	skipScenario,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import { waitForServerDown } from "../lib/poll.ts";
import { waitForEventCount, waitForSeqAbove } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
}

interface CreateRunResponse {
	readonly run: {
		readonly id: string;
		readonly state: string;
		readonly burrowId: string | null;
		readonly burrowRunId: string | null;
	};
}

interface EventEnvelope {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

interface ReadyzBody {
	readonly ok: boolean;
	readonly checks: ReadonlyArray<{
		readonly name: string;
		readonly ok: boolean;
		readonly message: string;
		readonly hint?: string;
	}>;
}

const PRE_KILL_MIN_EVENTS = 3;
const PRE_KILL_TIMEOUT_MS = 20_000;
const KILL_DRAIN_TIMEOUT_MS = 10_000;
const POST_RESTART_TIMEOUT_MS = 30_000;

export const scenario: Scenario = {
	id: "19",
	title: "warren-on-postgres: end-to-end dispatch + restart-recovery against pg backend",
	// Requires the host-side fixtures (sample project, canopy, stub agent),
	// plus a kill/restart lifecycle hook. In-proc only — the compose
	// launcher doesn't expose pg-URL injection or warren lifecycle.
	modes: ["in-proc"],
	async run(ctx) {
		const baseUrl = process.env.WARREN_TEST_PG_URL?.trim();
		if (baseUrl === undefined || baseUrl === "") {
			skipScenario(
				"WARREN_TEST_PG_URL not set — scenario 19 requires a reachable Postgres with CREATEDB. " +
					"Example: WARREN_TEST_PG_URL=postgres://warren:warren@127.0.0.1:5432/warren_test",
			);
		}

		// Per-scenario database name. CREATEDB happens on a maintenance
		// connection to the base URL's db; warren itself opens against the
		// freshly-created db so its migrations run cleanly (no shared
		// `__drizzle_migrations` to skip-cache across scenario runs).
		const dbSuffix = randomBytes(4).toString("hex");
		const scenarioDbName = `warren_acc19_${dbSuffix}`;
		const scenarioUrl = swapDatabaseName(baseUrl, scenarioDbName);
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-19-"));

		ctx.logger.info(
			`scenario-19: provisioning pg database ${scenarioDbName} (base=${redactPgUrl(baseUrl)})`,
		);
		await createDatabase(baseUrl, scenarioDbName);

		// Inherit insteadOf redirects from the harness's outer git-config so
		// `https://github.com/warren-acceptance/sample.git` clones from the
		// local fixture. The outer harness wrote one to ctx.tmp/git-config;
		// we copy it byte-for-byte rather than rebuild fixtures.
		const outerGitConfig = await readFile(join(ctx.tmp, "git-config"), "utf8");
		const gitConfigPath = join(scenarioRoot, "git-config");
		await writeFile(gitConfigPath, outerGitConfig);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: scenarioRoot,
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				dbUrl: scenarioUrl,
				extraEnv: {
					// Same per-second heartbeat shape scenario 06 relies on so
					// the bridge has a steady stream of new burrow events
					// during the warren-down window. Without it, the resume
					// path is silently dormant.
					WARREN_STUB_SLEEP_MS: "8000",
				},
			});
			ctx.logger.info(`scenario-19: warren ready at ${handle.warrenUrl} (pg=${scenarioDbName})`);

			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });

			// /readyz must surface the pg dialect on the db_reachable check
			// (mx-70f8d2). This both validates the boot picked up our URL
			// and exercises the dialect-aware ping path on pg.
			await assertDbReachableOnPostgres(http);

			await http.expectStatus("POST", "/agents/refresh", 200);
			const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

			const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
				body: {
					agent: ctx.fixtures.stubAgentName,
					project: project.id,
					prompt: "scenario-19 warren-on-postgres",
				},
			});
			const runId = created.run.id;
			assertTrue(
				typeof created.run.burrowRunId === "string" && created.run.burrowRunId !== null,
				"POST /runs must attach burrow_run_id by the 201 — bootBridges resume needs it",
			);
			ctx.logger.debug(`scenario-19: spawned ${runId} (burrow_run_id=${created.run.burrowRunId})`);

			try {
				const beforeKill = await waitForEventCount<EventEnvelope>(
					http,
					runId,
					PRE_KILL_MIN_EVENTS,
					PRE_KILL_TIMEOUT_MS,
				);
				assertNoSeqGaps(beforeKill, "pre-kill event sequence (pg)");
				const maxSeqBeforeKill = beforeKill[beforeKill.length - 1]?.seq ?? 0;
				ctx.logger.debug(
					`scenario-19: pre-kill events=${beforeKill.length} maxSeq=${maxSeqBeforeKill}`,
				);

				const lifecycle = handle;
				await lifecycle.killWarren();
				ctx.logger.debug("scenario-19: warren killed; waiting for the port to stop answering");
				await waitForServerDown(ctx.warrenUrl, KILL_DRAIN_TIMEOUT_MS);

				await lifecycle.restartWarren();
				ctx.logger.debug("scenario-19: warren restarted; verifying pg-backed resume");

				// Same post-restart pg dialect check — re-attaching to the
				// existing database, not re-migrating.
				await assertDbReachableOnPostgres(http);

				const afterRestart = await waitForSeqAbove<EventEnvelope>(
					http,
					runId,
					maxSeqBeforeKill,
					POST_RESTART_TIMEOUT_MS,
				);
				const maxSeqAfter = afterRestart[afterRestart.length - 1]?.seq ?? 0;
				assertTrue(
					maxSeqAfter > maxSeqBeforeKill,
					`expected resumed bridge to write seq > ${maxSeqBeforeKill}, got max ${maxSeqAfter}`,
				);
				ctx.logger.debug(
					`scenario-19: post-restart events=${afterRestart.length} maxSeq=${maxSeqAfter}`,
				);

				assertNoSeqGaps(afterRestart, "post-restart event sequence (pg)");
				assertEqual(afterRestart[0]?.seq ?? 0, 1, "first event in pg table is seq=1");
				assertEqual(
					afterRestart[afterRestart.length - 1]?.seq ?? 0,
					maxSeqAfter,
					"final event's seq matches max (pg)",
				);

				const allSeqs = new Set(afterRestart.map((e) => e.seq));
				for (const env of beforeKill) {
					assertTrue(allSeqs.has(env.seq), `post-restart pg events lost pre-kill seq ${env.seq}`);
				}

				const reread = await http.expectJson<{ burrowRunId: string | null }>(
					"GET",
					`/runs/${encodeURIComponent(runId)}`,
					200,
				);
				assertEqual(
					reread.burrowRunId,
					created.run.burrowRunId,
					"GET /runs/:id post-restart preserves burrow_run_id (pg)",
				);
			} finally {
				await safelyCancel(http, runId, ctx);
			}
		} finally {
			if (handle !== undefined) {
				await handle.stop().catch(() => undefined);
			}
			// Drop the scenario database after warren has released its pool.
			// `WITH (FORCE)` requires pg 13+; the docker-compose images warren
			// targets ship 16 by default. Fallback path terminates backends
			// first for older deployments.
			try {
				await dropDatabase(baseUrl, scenarioDbName);
			} catch (err) {
				ctx.logger.warn(
					`scenario-19: best-effort DROP DATABASE ${scenarioDbName} failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
	},
};

async function assertDbReachableOnPostgres(http: WarrenHttp): Promise<void> {
	// /readyz returns 200 when all checks pass, 503 if any fail. Accept
	// either so we can surface a precise db_reachable failure even when
	// some other check (canopy_clean on a fresh clone, bwrap on macOS) is
	// degraded.
	const res = await http.request("GET", "/readyz");
	if (res.status !== 200 && res.status !== 503) {
		throw new AcceptanceError(
			`GET /readyz: expected 200 or 503, got ${res.status}: ${await res.text()}`,
		);
	}
	const readyz = (await res.json()) as ReadyzBody;
	const dbCheck = readyz.checks.find((c) => c.name === "db_reachable");
	if (dbCheck === undefined) {
		throw new AcceptanceError(
			`/readyz response missing db_reachable check: ${JSON.stringify(readyz)}`,
		);
	}
	assertTrue(
		dbCheck.ok,
		`db_reachable not ok on pg backend: ${dbCheck.message}${dbCheck.hint ? ` (hint: ${dbCheck.hint})` : ""}`,
	);
	// checkDatabaseReachable (src/diagnostics/checks.ts:377) emits
	// `dialect=<sqlite|postgres>` in `message` on success.
	assertEqual(
		dbCheck.message,
		"dialect=postgres",
		"db_reachable message echoes the pg dialect (warren booted on pg)",
	);
}

function assertNoSeqGaps(events: readonly EventEnvelope[], label: string): void {
	if (events.length === 0) {
		throw new AcceptanceError(`${label}: empty event list`);
	}
	const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
	for (let i = 1; i < seqs.length; i++) {
		const prev = seqs[i - 1] ?? 0;
		const cur = seqs[i] ?? 0;
		if (cur !== prev + 1) {
			throw new AcceptanceError(
				`${label}: gap in seq numbers ${prev} → ${cur} at index ${i} (full seqs=${JSON.stringify(seqs)})`,
			);
		}
	}
}

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const existing = await http.expectJson<{ projects: (ProjectRow & { gitUrl: string })[] }>(
		"GET",
		"/projects",
		200,
	);
	const found = existing.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return { id: found.id };
	return await http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function safelyCancel(http: WarrenHttp, runId: string, ctx: ScenarioCtx): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch (err) {
		ctx.logger.debug(
			`scenario-19: cancel failed (${err instanceof Error ? err.message : String(err)}) — best-effort, continuing`,
		);
	}
}

/**
 * Build a Postgres URL targeting a different database name. The base URL's
 * userinfo, host, port, search params, and connection options are preserved
 * verbatim — only the pathname (database name) changes.
 */
function swapDatabaseName(baseUrl: string, dbName: string): string {
	const u = new URL(baseUrl);
	u.pathname = `/${dbName}`;
	return u.toString();
}

/**
 * Open a one-shot maintenance connection to the base URL and `CREATE
 * DATABASE`. We don't reuse warren's pool because warren hasn't been
 * spawned yet — the new database must exist before warren tries to
 * connect.
 */
async function createDatabase(baseUrl: string, dbName: string): Promise<void> {
	const client = new Client({ connectionString: baseUrl });
	await client.connect();
	try {
		// `CREATE DATABASE` can't run inside a transaction block and doesn't
		// accept parameterized identifiers — quote-escape the name. The
		// suffix is random hex so injection is not a concern, but the
		// quoting keeps the SQL well-formed for unusual db-name characters.
		await client.query(`CREATE DATABASE "${escapeIdent(dbName)}"`);
	} finally {
		await client.end().catch(() => undefined);
	}
}

/**
 * Drop the per-scenario database. Uses `WITH (FORCE)` (pg ≥ 13) to evict
 * any lingering backends from the warren pool — `handle.stop()` already
 * awaits `pool.end()` but a stuck client connection (rare; surfaces
 * occasionally on aborted streams) would otherwise hold the drop.
 */
async function dropDatabase(baseUrl: string, dbName: string): Promise<void> {
	const client = new Client({ connectionString: baseUrl });
	await client.connect();
	try {
		try {
			await client.query(`DROP DATABASE IF EXISTS "${escapeIdent(dbName)}" WITH (FORCE)`);
		} catch (err) {
			// Older pg (<13) doesn't support WITH (FORCE). Fall back to the
			// manual sequence: terminate backends, then drop.
			const message = err instanceof Error ? err.message : String(err);
			if (!/syntax error|FORCE/i.test(message)) throw err;
			await client.query(
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
				[dbName],
			);
			await client.query(`DROP DATABASE IF EXISTS "${escapeIdent(dbName)}"`);
		}
	} finally {
		await client.end().catch(() => undefined);
	}
}

/** Double-quote an SQL identifier (escape `"` as `""`). */
function escapeIdent(name: string): string {
	return name.replace(/"/g, '""');
}

/** Strip userinfo from a pg URL for logging. */
function redactPgUrl(url: string): string {
	try {
		const u = new URL(url);
		u.username = "";
		u.password = "";
		return u.toString();
	} catch {
		return "postgres://<unparseable>";
	}
}
