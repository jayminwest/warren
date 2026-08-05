/**
 * @warren-ext/audit-log — the flagship warren observer extension (plan pl-116e).
 *
 * A standalone Bun package. It consumes warren's EXISTING HTTP surfaces only
 * (runs list + per-run NDJSON event tails), keeps a durable cursor in its own
 * SQLite store, normalizes lifecycle facts into append-only audit rows, and
 * exports `GET /audit-log.jsonl?since=` plus `/healthz`.
 *
 * Boundary contract (enforced by scripts/check-layers.ts, rules
 * `extensions-are-standalone` and `core-does-not-import-extensions`): this
 * package imports nothing from warren's `src/` or `scripts/`, and warren core
 * imports nothing from here. Everything it knows about warren's wire shapes is
 * derived from docs/openapi.yaml and observed responses — the places that hurt
 * are logged in FRICTION.md.
 *
 * Build order (plan pl-116e):
 *   warren-0781 — scaffold + the boundary gate (done)
 *   warren-a0ff — collector: cursor-tailing client with durable resume (done)
 *   warren-653a — audit store and normalization, idempotent replay (done)
 *   warren-9c7c — export and health surface, retention (done)
 *   warren-88b8 — container image, README env contract, final FRICTION.md (done)
 *   warren-c8c3 — end-to-end smoke with golden export (done)
 */

import { AuditStore } from "./audit-store.ts";
import { createClient } from "./client.ts";
import { runCollector } from "./collector.ts";
import { CursorStore } from "./cursor-store.ts";
import { createExportServer, type HealthState } from "./server.ts";

export const EXTENSION_NAME = "audit-log";
export const EXTENSION_VERSION = "0.0.0";

export { AuditStore, type AuditRow } from "./audit-store.ts";
export { createClient, readEventsSince, listRuns, WarrenHttpError } from "./client.ts";
export { collectOnce, runCollector, type EventSink, type CycleStats } from "./collector.ts";
export { CursorStore, type RunCursor } from "./cursor-store.ts";
export {
	createExportServer,
	createFetchHandler,
	type ExportServerDeps,
	type HealthState,
} from "./server.ts";
export {
	AUDIT_EVENT_TYPES,
	ACTOR_KIND_UNKNOWN,
	type AuditEventType,
	type AuditFact,
	factsFromEvent,
	factsFromRun,
} from "./normalize.ts";
export {
	type RunEvent,
	type RunListRow,
	type RunState,
	RUN_STATES,
	isTerminalRunState,
	WireDriftError,
} from "./wire.ts";

/** Configuration the extension resolves from its environment. */
export interface ExtensionConfig {
	/** Base URL of the warren instance to observe, e.g. https://warren.example.com */
	readonly warrenBaseUrl: string;
	/** Bearer credential for warren's API. Never logged, never echoed by /healthz. */
	readonly warrenApiToken: string;
	/** Path of the extension-owned SQLite store (cursors now, audit rows in step 3). */
	readonly dbPath: string;
	/** Delay between poll cycles. */
	readonly pollIntervalMs: number;
	/** Events fetched per tail page. */
	readonly eventsPageSize: number;
	/** Port the export surface listens on. */
	readonly listenPort: number;
	/** Retention: keep at most this many audit rows. 0 = unlimited. */
	readonly retentionMaxRows: number;
	/** Retention: drop rows older than this. 0 = unlimited. */
	readonly retentionMaxAgeMs: number;
}

const DEFAULT_DB_PATH = "./data/audit-log.db";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_EVENTS_PAGE_SIZE = 500;
const DEFAULT_LISTEN_PORT = 8080;
const DEFAULT_RETENTION_MAX_ROWS = 0;
const DEFAULT_RETENTION_MAX_AGE_MS = 0;
const RETENTION_SWEEP_INTERVAL_MS = 60_000;

function parseNonNegativeIntEnv(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || String(n) !== raw) {
		throw new Error(`${name} must be a non-negative integer; got '${raw}'`);
	}
	return n;
}

function parsePositiveIntEnv(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1 || String(n) !== raw) {
		throw new Error(`${name} must be a positive integer; got '${raw}'`);
	}
	return n;
}

/** Resolve the environment contract, or name every missing variable. */
export function resolveConfig(
	env: Record<string, string | undefined>,
): { ok: true; config: ExtensionConfig } | { ok: false; missing: string[] } {
	const missing: string[] = [];
	const warrenBaseUrl = env.WARREN_BASE_URL;
	const warrenApiToken = env.WARREN_API_TOKEN;
	if (warrenBaseUrl === undefined || warrenBaseUrl === "") missing.push("WARREN_BASE_URL");
	if (warrenApiToken === undefined || warrenApiToken === "") missing.push("WARREN_API_TOKEN");
	if (missing.length > 0 || warrenBaseUrl === undefined || warrenApiToken === undefined) {
		return { ok: false, missing };
	}
	return {
		ok: true,
		config: {
			warrenBaseUrl,
			warrenApiToken,
			dbPath: env.AUDIT_LOG_DB_PATH ?? DEFAULT_DB_PATH,
			pollIntervalMs: parsePositiveIntEnv(
				env,
				"AUDIT_LOG_POLL_INTERVAL_MS",
				DEFAULT_POLL_INTERVAL_MS,
			),
			eventsPageSize: parsePositiveIntEnv(
				env,
				"AUDIT_LOG_EVENTS_PAGE_SIZE",
				DEFAULT_EVENTS_PAGE_SIZE,
			),
			listenPort: parsePositiveIntEnv(env, "AUDIT_LOG_LISTEN_PORT", DEFAULT_LISTEN_PORT),
			retentionMaxRows: parseNonNegativeIntEnv(
				env,
				"AUDIT_LOG_RETENTION_MAX_ROWS",
				DEFAULT_RETENTION_MAX_ROWS,
			),
			retentionMaxAgeMs: parseNonNegativeIntEnv(
				env,
				"AUDIT_LOG_RETENTION_MAX_AGE_MS",
				DEFAULT_RETENTION_MAX_AGE_MS,
			),
		},
	};
}

async function main(): Promise<void> {
	const resolved = resolveConfig(process.env);
	if (!resolved.ok) {
		console.error(
			`${EXTENSION_NAME}: missing required environment: ${resolved.missing.join(", ")}`,
		);
		process.exit(1);
	}
	const { config } = resolved;
	const client = createClient({ baseUrl: config.warrenBaseUrl, token: config.warrenApiToken });
	const store = new CursorStore(config.dbPath);
	const sink = new AuditStore(config.dbPath);

	const ctrl = new AbortController();
	const shutdown = (): void => ctrl.abort();
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	const health: HealthState = {
		lastCycle: null,
		lastCycleAt: null,
		lastCycleError: null,
		startedAt: new Date(),
	};
	const server = createExportServer({
		store: sink,
		cursors: store,
		health,
		extensionName: EXTENSION_NAME,
		extensionVersion: EXTENSION_VERSION,
		port: config.listenPort,
	});

	const sweep = setInterval(() => {
		const deleted = sink.pruneRetention({
			maxRows: config.retentionMaxRows,
			maxAgeMs: config.retentionMaxAgeMs,
		});
		if (deleted > 0) console.error(`${EXTENSION_NAME}: retention pruned ${deleted} rows`);
	}, RETENTION_SWEEP_INTERVAL_MS);
	sweep.unref();

	console.error(
		`${EXTENSION_NAME} ${EXTENSION_VERSION}: collecting from ${config.warrenBaseUrl} ` +
			`every ${config.pollIntervalMs}ms (db ${config.dbPath}); ` +
			`export surface on :${server.port}`,
	);
	await runCollector({
		client,
		store,
		sink,
		pollIntervalMs: config.pollIntervalMs,
		eventsPageSize: config.eventsPageSize,
		signal: ctrl.signal,
		onCycle: (stats) => {
			health.lastCycle = stats;
			health.lastCycleAt = new Date().toISOString();
			health.lastCycleError = null;
		},
		onCycleError: (err) => {
			health.lastCycleError = err instanceof Error ? err.message : String(err);
			console.error(`${EXTENSION_NAME}: cycle failed:`, err);
		},
		onRunError: (runId, err) =>
			console.error(`${EXTENSION_NAME}: tail for run ${runId} failed:`, err),
	});
	clearInterval(sweep);
	server.stop();
	store.close();
	sink.close();
	console.error(`${EXTENSION_NAME}: stopped; ${sink.count()} audit rows stored`);
}

if (import.meta.main) await main();
