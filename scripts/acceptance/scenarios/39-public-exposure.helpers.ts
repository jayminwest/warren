/**
 * File-local helper group for scenario 39 (`39-public-exposure.ts`).
 *
 * Mirrors the precedent in `20-preview.helpers.ts` and
 * `26-plan-run-roundtrip.helpers.ts`: the db seeder, the forbidden-token
 * vocabulary, the route-path derivation and the leak assertions live here
 * so the scenario body stays under the per-file line budget.
 *
 * Two things here carry the weight of the whole scenario:
 *
 *   1. **Nothing is hand-listed.** The blocked-route set and the
 *      public-route set are derived from `API_ROUTE_POLICIES`, and the
 *      forbidden field names from the exported `REDACTED_*` constants
 *      (warren-946f widened `REDACTED_RUN_FIELDS` past the classification's
 *      original four names — a hand-copied list here would already be
 *      stale). Add a route or a redacted field and this scenario covers it
 *      on the next run without an edit.
 *   2. **Every redacted column is seeded with a unique sentinel.** A
 *      projection that starts leaking a field fails on the VALUE, not just
 *      on the key name — so a rename can't slip a leak past the guard.
 *
 * The seeded rows go in through warren's own repos before the server boots,
 * so the scenario needs no burrow dispatch, no canopy CLI, and no LLM: it
 * is deterministic on any machine and cheap enough to run per-PR.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { openDatabase } from "../../../src/db/client.ts";
import { createRepos, type Repos } from "../../../src/db/repos/index.ts";
import { REDACTED_AGENT_FIELDS } from "../../../src/server/handlers/agents.ts";
import { API_ROUTE_POLICIES } from "../../../src/server/handlers/index.ts";
import { REDACTED_PROJECT_FIELDS } from "../../../src/server/handlers/projects.ts";
import { REDACTED_RUN_ANALYTICS_FIELDS } from "../../../src/server/handlers/runs/analytics.ts";
import { REDACTED_RUN_FIELDS } from "../../../src/server/handlers/runs/lifecycle.ts";
import { AcceptanceError } from "../lib/assert.ts";

/** Owner of the seeded project; also the whole public org allowlist. */
export const PUBLIC_ORG = "warren-acceptance";
/** The agent the public sweep reads. */
export const PUBLIC_AGENT_NAME = "stub-shell";
/**
 * Agent whose `rendered_json` is deliberately invalid JSON. Reading it
 * forces the handler to raise an untyped SyntaxError — that is how the
 * scenario proves a forced 500 leaks nothing.
 *
 * The row is written by {@link poisonAgentRow} AFTER the public read sweep,
 * not by the seeder: warren-f787 deleted the project tier, so every agent
 * row is now visible to `GET /agents` and a poison row present at seed time
 * would 500 the sweep it is supposed to run beside.
 */
export const POISON_AGENT_NAME = "acceptance-poison-agent";
/** Body of the steering message the anonymous inbox poll must not drain. */
export const INBOX_BODY = "scenario-39: this steering message belongs to the operator";

/**
 * Unique strings planted in every redacted column / secret-shaped payload.
 * Absence of each from every anonymous body is the value-level half of the
 * guard (the key-name half is {@link FORBIDDEN_FIELD_NAMES}).
 */
export const SENTINELS = {
	runRenderedAgent: "LEAKSENTINEL-RUN-RENDERED-AGENT-JSON",
	runBurrowId: "brw_LEAKSENTINELBURROWID",
	runBurrowRunId: "brun_LEAKSENTINELBURROWRUNID",
	runWorkerId: "wrk-LEAKSENTINELWORKERID",
	runPreviewFailure: "LEAKSENTINEL-PREVIEW-STDERR-TAIL",
	agentRenderedJson: "LEAKSENTINEL-AGENT-SYSTEM-PROMPT",
	agentResolvedFrom: "LEAKSENTINEL-CANOPY-RESOLVED-FROM",
	eventAnthropicKey: "sk-ant-LEAKSENTINELANTHROPICKEY0001",
	eventBearerToken: "LEAKSENTINELBEARERTOKEN00000001",
	eventApiKeyField: "LEAKSENTINEL-APIKEY-FIELD-VALUE",
	// The password embedded in a Supabase-style DSN's URL userinfo
	// (WARREN_DB_URL shape). warren-6fa0: the userinfo pattern redacts it.
	eventDsnPassword: "LEAKSENTINELDSNPASSWORD00000001",
	// A generic `https://user:pass@host` userinfo credential (warren-6fa0).
	eventUserinfoPassword: "LEAKSENTINELUSERINFOPW0000001",
	// A full JWT (three base64url segments). warren-6fa0: the JWT pattern
	// redacts it whole. `eyJ` header prefix keeps it off ordinary identifiers.
	eventJwt:
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiTEVBS1NFTlRJTkVMSldUUk9MRSJ9.LEAKSENTINELJWTSIGNATURE0001",
} as const;

/**
 * Field names that must never appear in an anonymous body, derived from the
 * exported complements of each public projection. Every name here is
 * substring-unambiguous: none is a prefix or infix of a field the
 * projections deliberately keep (`costUsd`, `previewState`, …), so a raw
 * body scan is sound.
 *
 * `REDACTED_RUN_TOTALS_FIELDS` (`cost`) and `REDACTED_RUN_GROUP_FIELDS`
 * (`costUsd` / `priced`) are deliberately NOT here — those names DO collide
 * with public ones, so the scenario holds them structurally instead
 * (`assertAnalyticsRollupsAbsent`).
 */
export const FORBIDDEN_FIELD_NAMES: readonly string[] = [
	...REDACTED_RUN_FIELDS,
	...REDACTED_PROJECT_FIELDS,
	...REDACTED_AGENT_FIELDS,
	...REDACTED_RUN_ANALYTICS_FIELDS,
	// Envelope-level, not a row column, so it belongs to no REDACTED_* list:
	// the instance-wide all-time rollup `GET /runs` drops for a spectator
	// (warren-946f).
	"costTotalUsd",
	// Nested inside the agent `renderedJson` the projection drops whole; named
	// explicitly because it is the canopy source-path disclosure the
	// classification calls out by name (warren-4f6c).
	"resolvedFrom",
];

/**
 * Host-layout shapes no anonymous body may carry. `/data/` catches the
 * projects root under warren's data dir (the shape `localPath` has in every
 * container deploy AND under this scenario's temp root); `/home/` catches a
 * developer-machine clone path.
 */
export const FORBIDDEN_PATH_FRAGMENTS: readonly string[] = ["/data/", "/home/"];

/**
 * A `Bearer` on the wire is only acceptable when the scrubber has already
 * replaced the credential after it — `[redacted]` (warren-1cb7 keeps the
 * header prefix on purpose so the redaction still reads as a header). This
 * is the one place the scenario deviates from a flat "no `Bearer `"
 * substring rule: any OTHER follower long enough to BE a credential is a
 * leak. The 12-char floor keeps ordinary prose out (several 403 envelopes
 * hint "authenticate with an operator bearer token") while still catching
 * every real token shape — the same floor `buildEnvSecretPattern` uses to
 * decide a value is worth redacting at all.
 */
export const UNREDACTED_BEARER = /bearer\s+(?!\[redacted\])[\w.\-+/=~]{12,}/i;

export interface SeededIds {
	readonly projectId: string;
	readonly runId: string;
	readonly planRunId: string;
	readonly agentName: string;
	readonly poisonAgentName: string;
	readonly seedId: string;
}

export interface SeedPublicInstanceInput {
	/** Scenario-private temp root; the sqlite file lands under `data/`. */
	readonly tmpRoot: string;
	/**
	 * The instance's own operator token. Planted verbatim in an event
	 * payload so the scrubber's env-literal matcher
	 * (`buildEnvSecretPattern`) is exercised, not just its shape patterns.
	 */
	readonly instanceToken: string;
}

/**
 * Build the public instance's database BEFORE warren boots: one project,
 * two agents, one terminal run with every redacted column populated, an
 * event log carrying planted secrets and one internal-only kind, an unread
 * steering message, and a plan-run whose child points at the run.
 *
 * The run is left TERMINAL so warren's boot-time bridge resume has nothing
 * to reattach — that is what keeps the scenario independent of burrow.
 */
export async function seedPublicInstanceDb(input: SeedPublicInstanceInput): Promise<SeededIds> {
	const dataDir = join(input.tmpRoot, "data");
	const localPath = join(dataDir, "projects", PUBLIC_ORG, "sample");
	await mkdir(localPath, { recursive: true });

	const db = await openDatabase({ path: join(dataDir, "warren.db") });
	try {
		const repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: `https://github.com/${PUBLIC_ORG}/sample.git`,
			localPath,
			defaultBranch: "main",
			hasSeeds: true,
		});
		await repos.agents.upsert({
			name: PUBLIC_AGENT_NAME,
			renderedJson: {
				frontmatter: { description: "scenario-39 stub", provider: "claude-code", model: "opus" },
				sections: { system: SENTINELS.agentRenderedJson },
				resolvedFrom: SENTINELS.agentResolvedFrom,
			},
		});
		const seedId = "ah-39-1";
		const run = await repos.runs.create({
			agentName: PUBLIC_AGENT_NAME,
			projectId: project.id,
			prompt: "scenario-39: public-exposure regression run",
			renderedAgentJson: {
				frontmatter: { provider: "claude-code", model: "opus" },
				sections: { system: SENTINELS.runRenderedAgent },
			},
			trigger: "manual",
			burrowId: SENTINELS.runBurrowId,
			burrowRunId: SENTINELS.runBurrowRunId,
			workerId: SENTINELS.runWorkerId,
			seedId,
		});
		await repos.runs.attachStats(run.id, {
			costUsd: 1.25,
			tokensInput: 4_096,
			tokensOutput: 512,
		});
		await repos.runs.attachPreview(run.id, {
			previewState: "failed",
			previewPort: 41_234,
			previewFailureMessage: `${SENTINELS.runPreviewFailure}: /home/warren/preview.log`,
		});
		await repos.runs.markRunning(run.id);
		await repos.runs.finalize(run.id, "succeeded");

		await seedEvents(repos, run.id, input.instanceToken);
		await repos.runInbox.enqueue({ runId: run.id, body: INBOX_BODY });

		const planRun = await repos.planRuns.create({
			planId: "pl-3900",
			projectId: project.id,
			agentName: PUBLIC_AGENT_NAME,
			children: [{ seq: 1, seedId }],
		});
		await repos.planRuns.updateChild({
			planRunId: planRun.planRun.id,
			seq: 1,
			patch: { runId: run.id, state: "merged" },
		});

		return {
			projectId: project.id,
			runId: run.id,
			planRunId: planRun.planRun.id,
			agentName: PUBLIC_AGENT_NAME,
			poisonAgentName: POISON_AGENT_NAME,
			seedId,
		};
	} finally {
		await db.close();
	}
}

/**
 * Write the poison agent row against the LIVE instance's database, after
 * the public read sweep has run (see {@link POISON_AGENT_NAME}).
 *
 * The row goes in through a second sqlite connection on the same file —
 * WAL admits the one writer, and the server reads it back on the next
 * request. `skipMigrations` because the seeder already migrated this
 * database and warren has since booted against it.
 *
 * The value is written with a raw UPDATE: `rendered_json` is a drizzle
 * `{ mode: "json" }` text column, so an unparseable value can only be
 * written past the mapper. Read back through the agents handler it throws
 * an untyped SyntaxError — the 500 path warren-4385 must not narrate.
 */
export async function poisonAgentRow(tmpRoot: string): Promise<void> {
	const db = await openDatabase({
		path: join(tmpRoot, "data", "warren.db"),
		skipMigrations: true,
	});
	try {
		await createRepos(db).agents.upsert({
			name: POISON_AGENT_NAME,
			renderedJson: { sections: { system: "replaced below" } },
		});
		db.raw
			.query("UPDATE agents SET rendered_json = ? WHERE name = ?")
			.run("{ not json", POISON_AGENT_NAME);
	} finally {
		await db.close();
	}
}

/**
 * The transcript half. Five events: one whose payload carries a
 * shape-matched credential, one whose payload carries the instance's own
 * token (the env-literal matcher), one whose payload carries a
 * secret-NAMED field, one whose payload carries a DSN / userinfo URL / JWT
 * (the three shapes warren-6fa0 added), and one `bridge_lost` — the
 * internal kind `INTERNAL_EVENT_KINDS` drops whole rather than scrubs.
 */
async function seedEvents(repos: Repos, runId: string, instanceToken: string): Promise<void> {
	const ts = "2026-07-27T00:00:00.000Z";
	await repos.events.append({
		runId,
		burrowEventSeq: 1,
		ts,
		kind: "agent_output",
		stream: "stdout",
		payload: {
			text: `exporting ANTHROPIC_API_KEY=${SENTINELS.eventAnthropicKey} before the call`,
		},
	});
	await repos.events.append({
		runId,
		burrowEventSeq: 2,
		ts,
		kind: "agent_output",
		stream: "stdout",
		payload: {
			text: `curl -H "Authorization: Bearer ${SENTINELS.eventBearerToken}" https://api.warren.run/runs`,
			note: `and the control plane's own token: ${instanceToken}`,
		},
	});
	await repos.events.append({
		runId,
		burrowEventSeq: 3,
		ts,
		kind: "tool_use",
		stream: "stdout",
		payload: { input: { apiKey: SENTINELS.eventApiKeyField } },
	});
	await repos.events.append({
		runId,
		burrowEventSeq: 4,
		ts,
		kind: "agent_output",
		stream: "stdout",
		payload: {
			// A Supabase-style DSN (WARREN_DB_URL shape), a generic userinfo URL,
			// and a JWT — the three shapes warren-6fa0 added to the scrubber.
			dsn: `psql postgresql://postgres:${SENTINELS.eventDsnPassword}@db.proj.supabase.co:5432/postgres`,
			clone: `git clone https://alice:${SENTINELS.eventUserinfoPassword}@example.com/x.git`,
			jwt: `SUPABASE_SERVICE_ROLE_KEY=${SENTINELS.eventJwt}`,
		},
	});
	await repos.events.append({
		runId,
		burrowEventSeq: 5,
		ts,
		kind: "bridge_lost",
		stream: "system",
		payload: { burrowId: SENTINELS.runBurrowId, attempts: 3 },
	});
}

/* ----------------------------------------------------------------------- */
/* Route derivation                                                         */
/* ----------------------------------------------------------------------- */

/** Stand-in for a param whose value the route never reaches (blocked routes). */
const UNREACHED_PARAM = "acceptance-unreached";

export interface RouteCall {
	readonly method: string;
	readonly pattern: string;
	readonly path: string;
}

function fillParams(pattern: string, ids: SeededIds): { path: string; concrete: boolean } {
	let concrete = true;
	const path = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
		if (name === "name") return ids.agentName;
		if (name === "id" && pattern.startsWith("/runs/")) return ids.runId;
		if (name === "id" && pattern.startsWith("/plan-runs/")) return ids.planRunId;
		if (name === "id" && pattern.startsWith("/projects/")) return ids.projectId;
		concrete = false;
		return UNREACHED_PARAM;
	});
	return { path, concrete };
}

/**
 * Every route an anonymous caller must be REFUSED — derived as "policy is
 * neither `anonymous` nor `readPublic`", so a route added tomorrow with a
 * `readOperator` / `dispatch` / `admin` policy is covered without an edit.
 */
export function blockedRouteCalls(ids: SeededIds): readonly RouteCall[] {
	return API_ROUTE_POLICIES.filter(
		(r) => r.policy !== "anonymous" && r.policy !== "readPublic",
	).map((r) => ({ method: r.method, pattern: r.pattern, path: fillParams(r.pattern, ids).path }));
}

/**
 * Every GET an anonymous caller may reach. Params must resolve to a REAL
 * seeded id — a route whose param this helper can't fill would otherwise
 * 404 and the leak sweep would pass vacuously, so an unfillable one is a
 * hard error telling the next author to extend `fillParams`.
 */
export function publicGetCalls(ids: SeededIds): readonly RouteCall[] {
	return API_ROUTE_POLICIES.filter(
		(r) => r.method === "GET" && (r.policy === "anonymous" || r.policy === "readPublic"),
	).map((r) => {
		const { path, concrete } = fillParams(r.pattern, ids);
		if (!concrete) {
			throw new AcceptanceError(
				`scenario-39: no seeded id for a param of readable route GET ${r.pattern} — extend fillParams() so the leak sweep reads a populated body`,
			);
		}
		return { method: r.method, pattern: r.pattern, path };
	});
}

/* ----------------------------------------------------------------------- */
/* Leak assertions                                                          */
/* ----------------------------------------------------------------------- */

/**
 * The one assertion the whole scenario exists for: `body` — the verbatim
 * bytes an anonymous caller received from `label` — carries no redacted
 * field name, no planted sentinel, no host path, and no live bearer.
 */
export function assertNoLeak(label: string, body: string): void {
	for (const name of FORBIDDEN_FIELD_NAMES) {
		if (body.includes(name)) {
			throw new AcceptanceError(
				`${label}: anonymous body carries redacted field name ${JSON.stringify(name)} — a public projection widened (${excerptAround(body, name)})`,
			);
		}
	}
	for (const [key, sentinel] of Object.entries(SENTINELS)) {
		if (body.includes(sentinel)) {
			throw new AcceptanceError(
				`${label}: anonymous body carries the ${key} sentinel value (${excerptAround(body, sentinel)})`,
			);
		}
	}
	for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
		if (body.includes(fragment)) {
			throw new AcceptanceError(
				`${label}: anonymous body carries a host path fragment ${JSON.stringify(fragment)} (${excerptAround(body, fragment)})`,
			);
		}
	}
	const bearer = UNREDACTED_BEARER.exec(body);
	if (bearer !== null) {
		throw new AcceptanceError(
			`${label}: anonymous body carries an unredacted bearer credential (${excerptAround(body, bearer[0])})`,
		);
	}
}

/**
 * `GET /analytics/runs`: the USD rollups whose names collide with public
 * ones, checked structurally at the level they live on rather than by
 * substring. Field lists are imported so a re-classification reaches here.
 */
export function assertAnalyticsRollupsAbsent(
	body: Record<string, unknown>,
	totalsFields: readonly string[],
	groupFields: readonly string[],
): void {
	const totals = body.totals;
	if (totals === null || typeof totals !== "object") {
		throw new AcceptanceError("GET /analytics/runs: expected a `totals` object in the body");
	}
	for (const field of totalsFields) {
		if (field in (totals as Record<string, unknown>)) {
			throw new AcceptanceError(
				`GET /analytics/runs: totals.${field} is redacted for a spectator but present`,
			);
		}
	}
	for (const groupKey of ["byAgent", "byModel", "byProvider"]) {
		assertGroupRollupsAbsent(groupKey, body[groupKey], groupFields);
	}
}

/** One `byAgent` / `byModel` / `byProvider` bucket array. */
function assertGroupRollupsAbsent(
	groupKey: string,
	buckets: unknown,
	groupFields: readonly string[],
): void {
	if (!Array.isArray(buckets)) {
		throw new AcceptanceError(`GET /analytics/runs: expected \`${groupKey}\` to be an array`);
	}
	for (const bucket of buckets as readonly Record<string, unknown>[]) {
		for (const field of groupFields) {
			if (field in bucket) {
				throw new AcceptanceError(
					`GET /analytics/runs: ${groupKey}[].${field} is redacted for a spectator but present`,
				);
			}
		}
	}
}

/** A short window around `needle` so a failure names the offending bytes. */
function excerptAround(body: string, needle: string): string {
	const at = body.indexOf(needle);
	if (at < 0) return "no excerpt";
	const from = Math.max(0, at - 60);
	return `…${body.slice(from, at + needle.length + 60)}…`;
}
