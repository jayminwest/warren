import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { agents, type ProjectRow, projects } from "../../db/schema.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { PUBLIC_AGENT_FIELDS, REDACTED_AGENT_FIELDS, withAgentSource } from "./agents.ts";
import { PUBLIC_PROJECT_FIELDS, REDACTED_PROJECT_FIELDS } from "./projects.ts";
import {
	PUBLIC_RUN_ANALYTICS_FIELDS,
	PUBLIC_RUN_GROUP_FIELDS,
	PUBLIC_RUN_TOTALS_FIELDS,
	REDACTED_RUN_ANALYTICS_FIELDS,
	REDACTED_RUN_GROUP_FIELDS,
	REDACTED_RUN_TOTALS_FIELDS,
} from "./runs/analytics.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./runs.test-helpers.ts";

/**
 * Public projections for `GET /projects`, `GET /agents`, `GET /agents/:name`
 * and `GET /analytics/runs` (warren-4f6c / pl-b82d step 15).
 *
 * Same shape of proof as step 14's `runs.projection.test.ts`: the
 * classification is asserted as data (every column / every field of the
 * operator body lands in exactly one of the two exported lists, so a new
 * one fails this file until someone classifies it) and then over the wire
 * against a real server under `WARREN_AUTH=public`, anonymously and with
 * the operator token, so the "operator is unchanged" half is proved
 * rather than assumed.
 */

const TOKEN = "s3cret";

/** A burrow client that 404s everything — no route here reaches it. */
function inertBurrowClient(): BurrowClient {
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stub(
			async () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 }),
		),
	});
}

const RENDERED_CLAUDE_CODE = {
	name: "claude-code",
	version: 3,
	sections: {
		system: "You are a helpful coding assistant. SECRET-PROMPT-BODY.",
		burrow_config: '[sandbox]\nnetwork = "open"\n',
	},
	resolvedFrom: ["/data/canopy/prompts/base.md", "builtin:claude-code"],
	frontmatter: {
		source: "builtin",
		description: "General-purpose coding agent",
		provider: "anthropic",
		model: "claude-opus-4",
	},
};

describe("project + agent field classification (warren-4f6c)", () => {
	test("every projects column is classified exactly once", () => {
		const columns = Object.keys(getTableColumns(projects)) as (keyof ProjectRow)[];
		const classified = [...PUBLIC_PROJECT_FIELDS, ...REDACTED_PROJECT_FIELDS];
		expect([...classified].sort()).toEqual([...columns].sort());
		expect(new Set(classified).size).toBe(classified.length);
	});

	test("localPath is the only redacted project field", () => {
		expect([...REDACTED_PROJECT_FIELDS]).toEqual(["localPath"]);
		for (const kept of ["gitUrl", "defaultBranch", "hasSeeds", "addedAt"] as const) {
			expect(PUBLIC_PROJECT_FIELDS).toContain(kept);
		}
	});

	test("every decorated agent field is classified exactly once", () => {
		const decorated = Object.keys(
			withAgentSource({
				id: 1,
				name: "claude-code",
				renderedJson: RENDERED_CLAUDE_CODE,
				registeredAt: "2026-07-01T00:00:00.000Z",
				lastRefreshed: "2026-07-01T00:00:00.000Z",
			}),
		);
		const classified: string[] = [...PUBLIC_AGENT_FIELDS, ...REDACTED_AGENT_FIELDS];
		expect([...classified].sort()).toEqual([...decorated].sort());
		expect(new Set(classified).size).toBe(classified.length);
		// Every stored column is covered too, decorations aside.
		for (const column of Object.keys(getTableColumns(agents))) {
			expect(classified).toContain(column);
		}
	});

	test("renderedJson is the only redacted agent field", () => {
		expect([...REDACTED_AGENT_FIELDS]).toEqual(["renderedJson"]);
		for (const kept of ["name", "description", "provider", "model", "source"] as const) {
			expect(PUBLIC_AGENT_FIELDS).toContain(kept);
		}
	});

	test("withAgentSource hoists description / provider / model off frontmatter", () => {
		const decorated = withAgentSource({
			id: 1,
			name: "claude-code",
			renderedJson: RENDERED_CLAUDE_CODE,
			registeredAt: "2026-07-01T00:00:00.000Z",
			lastRefreshed: "2026-07-01T00:00:00.000Z",
		});
		expect(decorated.description).toBe("General-purpose coding agent");
		expect(decorated.provider).toBe("anthropic");
		expect(decorated.model).toBe("claude-opus-4");
		expect(decorated.source).toBe("builtin");
	});

	test("withAgentSource nulls the metadata when frontmatter is absent", () => {
		const decorated = withAgentSource({
			id: 2,
			name: "bare",
			renderedJson: { name: "bare", version: 1, sections: { system: "x" } },
			registeredAt: "2026-07-01T00:00:00.000Z",
			lastRefreshed: "2026-07-01T00:00:00.000Z",
		});
		expect(decorated.description).toBeNull();
		expect(decorated.provider).toBeNull();
		expect(decorated.model).toBeNull();
	});
});

describe("public projections over the wire (warren-4f6c)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
			hasSeeds: true,
		});
		projectId = project.id;
		await repos.agents.upsert({ name: "claude-code", renderedJson: RENDERED_CLAUDE_CODE });
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId,
			prompt: "fix the flaky test",
			renderedAgentJson: { frontmatter: { provider: "anthropic", model: "claude-opus-4" } },
			trigger: "manual",
			seedId: "warren-4f6c",
		});
		// Relative timestamps: the analytics handler's default window is the last
		// 30 days, so a fixed date eventually ages out and the window finds zero
		// runs (the 2026-07-30 instance of that time bomb).
		const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
		await repos.runs.markRunning(run.id, startedAt);
		await repos.runs.finalize(
			run.id,
			"succeeded",
			new Date(startedAt.getTime() + 5 * 60 * 1000),
			null,
		);
		await repos.runs.attachStats(run.id, {
			costUsd: 1.25,
			tokensInput: 100,
			tokensOutput: 20,
			tokensCacheRead: 40,
		});
		handle = startServer(await depsFor(repos, inertBurrowClient()), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger: silentLogger,
		});
		base = tcpUrl(handle);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function get(path: string, token?: string): Promise<Record<string, unknown>> {
		const res = await fetch(
			`${base}${path}`,
			token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
		);
		expect(res.status).toBe(200);
		return (await res.json()) as Record<string, unknown>;
	}

	/* --- GET /projects ---------------------------------------------- */

	test("anonymous GET /projects emits exactly the public field set", async () => {
		const list = (await get("/projects")).projects as Record<string, unknown>[];
		expect(list).toHaveLength(1);
		expect(Object.keys(list[0] ?? {}).sort()).toEqual([...PUBLIC_PROJECT_FIELDS].sort());
		expect(list[0]?.gitUrl).toBe("https://github.com/os-eco/warren.git");
		expect(list[0]?.hasSeeds).toBe(true);
	});

	test("no anonymous project body carries a server filesystem path", async () => {
		expect(JSON.stringify(await get("/projects"))).not.toContain("/data/projects");
	});

	test("the operator GET /projects body is the full row", async () => {
		const stored = await repos.projects.require(projectId);
		const list = (await get("/projects", TOKEN)).projects as Record<string, unknown>[];
		expect(Object.keys(list[0] ?? {}).sort()).toEqual(Object.keys(stored).sort());
		expect(list[0]?.localPath).toBe("/data/projects/os-eco/warren");
	});

	/* --- GET /agents, GET /agents/:name ------------------------------ */

	test("anonymous GET /agents emits exactly the public field set", async () => {
		const list = (await get("/agents")).agents as Record<string, unknown>[];
		expect(list).toHaveLength(1);
		expect(Object.keys(list[0] ?? {}).sort()).toEqual([...PUBLIC_AGENT_FIELDS].sort());
		expect(list[0]?.provider).toBe("anthropic");
		expect(list[0]?.model).toBe("claude-opus-4");
		expect(list[0]?.description).toBe("General-purpose coding agent");
		expect(list[0]?.source).toBe("builtin");
	});

	test("anonymous GET /agents/:name emits exactly the public field set", async () => {
		const agent = await get("/agents/claude-code");
		expect(Object.keys(agent).sort()).toEqual([...PUBLIC_AGENT_FIELDS].sort());
		for (const dropped of REDACTED_AGENT_FIELDS) {
			expect(agent).not.toHaveProperty(dropped);
		}
	});

	test("no system prompt or source path survives an anonymous agent body", async () => {
		const listed = JSON.stringify(await get("/agents"));
		const detail = JSON.stringify(await get("/agents/claude-code"));
		for (const secret of ["SECRET-PROMPT-BODY", "burrow_config", "resolvedFrom", "/data/canopy"]) {
			expect(listed).not.toContain(secret);
			expect(detail).not.toContain(secret);
		}
	});

	test("the operator agent body still carries the rendered envelope", async () => {
		const agent = await get("/agents/claude-code", TOKEN);
		expect(Object.keys(agent).sort()).toEqual(
			[...PUBLIC_AGENT_FIELDS, ...REDACTED_AGENT_FIELDS].sort(),
		);
		expect(agent.renderedJson).toEqual(RENDERED_CLAUDE_CODE);
	});

	/* --- GET /analytics/runs ----------------------------------------- */

	test("the operator analytics body partitions into the two field lists", async () => {
		const body = await get("/analytics/runs", TOKEN);
		expect(Object.keys(body).sort()).toEqual(
			[...PUBLIC_RUN_ANALYTICS_FIELDS, ...REDACTED_RUN_ANALYTICS_FIELDS].sort(),
		);
		const totals = body.totals as Record<string, unknown>;
		expect(Object.keys(totals).sort()).toEqual(
			[...PUBLIC_RUN_TOTALS_FIELDS, ...REDACTED_RUN_TOTALS_FIELDS].sort(),
		);
		const byAgent = (body.byAgent as Record<string, unknown>[])[0];
		expect(Object.keys(byAgent ?? {}).sort()).toEqual(
			[...PUBLIC_RUN_GROUP_FIELDS, ...REDACTED_RUN_GROUP_FIELDS].sort(),
		);
		expect(totals.cost).toEqual({ total: 1.25, avg: 1.25, priced: 1 });
		expect(body.topSeedsByContext).toHaveLength(1);
	});

	test("anonymous GET /analytics/runs drops topSeedsByContext and every USD rollup", async () => {
		const body = await get("/analytics/runs");
		expect(Object.keys(body).sort()).toEqual([...PUBLIC_RUN_ANALYTICS_FIELDS].sort());
		expect(body).not.toHaveProperty("topSeedsByContext");
		const totals = body.totals as Record<string, unknown>;
		expect(Object.keys(totals).sort()).toEqual([...PUBLIC_RUN_TOTALS_FIELDS].sort());
		expect(totals).not.toHaveProperty("cost");
		for (const dimension of ["byAgent", "byModel", "byProvider"] as const) {
			const buckets = body[dimension] as Record<string, unknown>[];
			expect(buckets.length).toBeGreaterThan(0);
			for (const bucket of buckets) {
				expect(Object.keys(bucket).sort()).toEqual([...PUBLIC_RUN_GROUP_FIELDS].sort());
			}
		}
	});

	test("anonymous GET /analytics/runs keeps counts, states and tokens", async () => {
		const body = await get("/analytics/runs");
		const totals = body.totals as Record<string, unknown>;
		expect(totals.runs).toBe(1);
		expect(totals.succeeded).toBe(1);
		expect(totals.successRate).toBe(1);
		expect((totals.tokens as Record<string, unknown>).total).toBe(160);
		expect(body.filter).toMatchObject({ projectId: null, to: null });
		expect((body.tokens as Record<string, unknown>).totals).toEqual(
			totals.tokens as Record<string, unknown>,
		);
	});

	test("no cost figure survives anywhere in the anonymous analytics body", async () => {
		const body = JSON.stringify(await get("/analytics/runs"));
		expect(body).not.toContain("costUsd");
		expect(body).not.toContain("1.25");
		expect(body).not.toContain("warren-4f6c");
	});
});
