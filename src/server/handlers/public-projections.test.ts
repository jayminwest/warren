import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { agents, type ProjectRow, projects } from "../../db/schema.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { PUBLIC_AGENT_FIELDS, REDACTED_AGENT_FIELDS, withAgentSource } from "./agents.ts";
import { PUBLIC_PROJECT_FIELDS, REDACTED_PROJECT_FIELDS } from "./projects.ts";
import {
	PUBLIC_COST_PER_MERGED_PR_BUCKET_FIELDS,
	PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS,
	PUBLIC_RUN_ANALYTICS_FIELDS,
	PUBLIC_RUN_GROUP_FIELDS,
	PUBLIC_RUN_TOTALS_FIELDS,
	REDACTED_COST_PER_MERGED_PR_OVERALL_FIELDS,
	REDACTED_RUN_ANALYTICS_FIELDS,
	REDACTED_RUN_GROUP_FIELDS,
	REDACTED_RUN_TOTALS_FIELDS,
} from "./runs/analytics.ts";
import {
	PUBLIC_CONTEXT_WASTE_FIELDS,
	PUBLIC_CONTEXT_WASTE_SHARE_FIELDS,
	REDACTED_CONTEXT_WASTE_FIELDS,
	REDACTED_CONTEXT_WASTE_SHARE_FIELDS,
} from "./runs/analytics-waste.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

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
function inertSandboxClient(): FakeProvider {
	return new FakeProvider();
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

describe("context-waste field classification (warren-6d41)", () => {
	test("every ContextWasteProxy field is classified exactly once, all operator-only", () => {
		// `/analytics/behavior` — the section's only surface — is readOperator,
		// so the public lists are empty and every field sits in the redacted
		// (operator-only) list: per-tool/per-command keys are internal tooling
		// detail, and the byte/token totals ride along.
		expect(PUBLIC_CONTEXT_WASTE_FIELDS).toHaveLength(0);
		const fields: string[] = [...REDACTED_CONTEXT_WASTE_FIELDS];
		expect(fields.sort()).toEqual(
			[
				"byCommand",
				"byTool",
				"confidence",
				"contextTokensTotal",
				"resultBytesTotal",
				"runsInWindow",
				"runsMeasured",
				"runsWithRollup",
				"share",
			].sort(),
		);
	});

	test("every ContextWasteShare field is classified exactly once, all operator-only", () => {
		expect(PUBLIC_CONTEXT_WASTE_SHARE_FIELDS).toHaveLength(0);
		const shareFields: string[] = [...REDACTED_CONTEXT_WASTE_SHARE_FIELDS];
		expect(shareFields.sort()).toEqual(
			[
				"contextTokensTotal",
				"invocations",
				"key",
				"resultBytesKnown",
				"resultBytesTotal",
				"runs",
				"runsMeasured",
				"share",
			].sort(),
		);
	});
});

// warren-6163: walk a parsed response body and report every cost-named key
// (except the public costPerMergedPr rollup, whose counts are public) and
// every occurrence of the seeded cost figure. Structural, so it cannot
// collide with ISO millisecond timestamps the way a substring match can.
function flattenEntries(body: unknown): [string, unknown][] {
	const out: [string, unknown][] = [];
	const stack: [string, unknown][] = [["", body]];
	while (stack.length > 0) {
		const [key, value] = stack.pop() as [string, unknown];
		out.push([key, value]);
		if (value === null || typeof value !== "object") continue;
		const children: [string, unknown][] = Array.isArray(value)
			? value.map((item) => ["", item])
			: Object.entries(value);
		stack.push(...children);
	}
	return out;
}

function findCostLeaks(body: unknown, seededCost: number): string[] {
	return flattenEntries(body)
		.filter(([key, value]) => /cost(?!PerMergedPr)/i.test(key) || value === seededCost)
		.map(([key, value]) => (value === seededCost ? `value:${key}` : `key:${key}`));
}

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
			costUsd: 987.6543,
			tokensInput: 100,
			tokensOutput: 20,
			tokensCacheRead: 40,
		});
		// warren-bd57: a resolved merge-watcher state so the landed-work
		// fields flow through both projections below.
		await repos.runs.setPrState(run.id, "merged", startedAt.toISOString());
		handle = startServer(await depsFor(repos, inertSandboxClient()), {
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
		// warren-be04: the operator body carries the full outcome-joined
		// rollup, cost figures included.
		const outcomes = body.outcomes as {
			costPerMergedPr: { overall: Record<string, unknown> };
		};
		expect(Object.keys(outcomes.costPerMergedPr.overall).sort()).toEqual(
			[
				...PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS,
				...REDACTED_COST_PER_MERGED_PR_OVERALL_FIELDS,
			].sort(),
		);
		expect(outcomes.costPerMergedPr.overall.costUsd).toBe(987.6543);
		expect(totals.cost).toEqual({ total: 987.6543, avg: 987.6543, priced: 1 });
		expect(body.topSeedsByContext).toHaveLength(1);
	});

	test("anonymous GET /analytics/runs drops topSeedsByContext and every USD rollup", async () => {
		const body = await get("/analytics/runs");
		expect(Object.keys(body).sort()).toEqual([...PUBLIC_RUN_ANALYTICS_FIELDS].sort());
		expect(body).not.toHaveProperty("topSeedsByContext");
		const totals = body.totals as Record<string, unknown>;
		expect(Object.keys(totals).sort()).toEqual([...PUBLIC_RUN_TOTALS_FIELDS].sort());
		expect(totals).not.toHaveProperty("cost");
		// warren-be04: outcomes survives — steering tallies and merged counts
		// are public — and warren-97ae makes the instance-wide cost/merged-PR
		// ratio public too; the per-bucket USD figures stay redacted.
		const outcomes = body.outcomes as {
			steering: { steered: { prStateKnown: number }; unsteered: { prStateKnown: number } };
			costPerMergedPr: {
				overall: Record<string, unknown>;
				byAgent: Record<string, unknown>[];
			};
		};
		expect(outcomes.steering.unsteered.prStateKnown).toBe(1);
		expect(Object.keys(outcomes.costPerMergedPr.overall).sort()).toEqual(
			[...PUBLIC_COST_PER_MERGED_PR_OVERALL_FIELDS].sort(),
		);
		expect(outcomes.costPerMergedPr.overall).not.toHaveProperty("costUsd");
		expect(outcomes.costPerMergedPr.overall).not.toHaveProperty("priced");
		expect(outcomes.costPerMergedPr.overall.prsMerged).toBe(1);
		// warren-97ae: the public ratio itself.
		expect(outcomes.costPerMergedPr.overall.costPerMergedPrUsd).toBeDefined();
		expect(outcomes.costPerMergedPr.overall.costPerMergedPrUsd).not.toBeNull();
		// warren-bc9c: delivery timings (public like queueWaitMs) and the
		// autonomy rollup (counts + a rate) survive the projection.
		const delivery = body.delivery as { branchPushToPrOpenMs: unknown };
		expect(delivery.branchPushToPrOpenMs).toBeDefined();
		expect((body.outcomes as { autonomy: { merged: number } }).autonomy.merged).toBe(1);
		for (const bucket of outcomes.costPerMergedPr.byAgent) {
			expect(Object.keys(bucket).sort()).toEqual(
				[...PUBLIC_COST_PER_MERGED_PR_BUCKET_FIELDS].sort(),
			);
		}
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
		// warren-bd57: landed-work fields are public — a rate, not a private fact.
		expect(totals.prStateKnown).toBe(1);
		expect(totals.prsMerged).toBe(1);
		expect(totals.mergedPrRate).toBe(1);
		const bucket = (body.byAgent as Record<string, unknown>[])[0];
		expect(bucket?.mergedPrRate).toBe(1);
		expect((totals.tokens as Record<string, unknown>).total).toBe(160);
		expect(body.filter).toMatchObject({ projectId: null });
		// warren-30cc: the resolved window is always bounded — both bounds echo as strings.
		const filter = body.filter as { from: unknown; to: unknown };
		expect(typeof filter.from).toBe("string");
		expect(typeof filter.to).toBe("string");
		expect((body.tokens as Record<string, unknown>).totals).toEqual(
			totals.tokens as Record<string, unknown>,
		);
	});

	test("no cost figure survives anywhere in the anonymous analytics body", async () => {
		const body = await get("/analytics/runs");
		// warren-6163: structural check, not a raw substring match — a seeded
		// figure like "1.25" can collide with an ISO millisecond timestamp
		// ("...:01.250Z") and flake the assertion. Walk the parsed body and
		// fail on any cost-named key or any occurrence of the seeded figure.
		// warren-97ae: the one deliberate exception is the instance-wide
		// cost/merged-PR ratio, which is public — with one merged PR it
		// numerically equals the seeded spend, so it shows up as exactly
		// that one value hit and nothing else (flattenEntries reports
		// immediate keys, not dotted paths).
		const leaks = findCostLeaks(body, 987.6543);
		expect(leaks).toEqual(["value:costPerMergedPrUsd"]);
		expect(JSON.stringify(body)).not.toContain("warren-4f6c");
	});
});
