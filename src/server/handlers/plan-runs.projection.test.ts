import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import {
	type PlanRunChildRow,
	type PlanRunRow,
	planRunChildren,
	planRuns,
} from "../../db/schema.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSdSpawn, silentLogger, tcpUrl } from "./plan-runs.test-helpers.ts";
import {
	PUBLIC_PLAN_RUN_CHILD_FIELDS,
	PUBLIC_PLAN_RUN_FIELDS,
	REDACTED_PLAN_RUN_CHILD_FIELDS,
	REDACTED_PLAN_RUN_FIELDS,
} from "./plan-runs-projection.ts";

/**
 * Public projections for `GET /plan-runs` and `GET /plan-runs/:id`
 * (warren-8793 / pl-61a4 step 3).
 *
 * Same shape of proof as `public-projections.test.ts`: the classification
 * is asserted as data (every column lands in exactly one of the two
 * exported lists, so a new column fails this file until someone
 * classifies it) and then over the wire against a real server under
 * `WARREN_AUTH=public`, anonymously and with the operator token, so the
 * "operator is unchanged" half is proved rather than assumed.
 */

const TOKEN = "s3cret";

describe("plan-run field classification (warren-8793)", () => {
	test("every plan_runs column is classified exactly once", () => {
		const columns = Object.keys(getTableColumns(planRuns)) as (keyof PlanRunRow)[];
		const classified = [...PUBLIC_PLAN_RUN_FIELDS, ...REDACTED_PLAN_RUN_FIELDS];
		expect([...classified].sort()).toEqual([...columns].sort());
		expect(new Set(classified).size).toBe(classified.length);
	});

	test("every plan_run_children column is classified exactly once", () => {
		const columns = Object.keys(getTableColumns(planRunChildren)) as (keyof PlanRunChildRow)[];
		const classified = [...PUBLIC_PLAN_RUN_CHILD_FIELDS, ...REDACTED_PLAN_RUN_CHILD_FIELDS];
		expect([...classified].sort()).toEqual([...columns].sort());
		expect(new Set(classified).size).toBe(classified.length);
	});

	test("the prompt template, dispatch config, dispatcher handle, and failure text stay redacted", () => {
		expect([...REDACTED_PLAN_RUN_FIELDS].sort().join(",")).toBe(
			[
				"dispatcherHandle",
				"failureReason",
				"maxCostUsd",
				"modelOverride",
				"promptTemplate",
				"providerOverride",
			]
				.sort()
				.join(","),
		);
		expect([...REDACTED_PLAN_RUN_CHILD_FIELDS]).toEqual(["failureReason"]);
	});
});

describe("plan-run public wire projection (warren-8793)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const seedy = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy",
			defaultBranch: "main",
			hasSeeds: true,
		});
		projectId = seedy.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function servePublic(): Promise<void> {
		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth(TOKEN)),
			logger: silentLogger,
		});
	}

	async function seedFailedPlanRun(): Promise<string> {
		const created = await repos.planRuns.create({
			planId: "pl-secret",
			projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
			promptTemplate: "work on sd {seed_id} SECRET-TEMPLATE",
			providerOverride: "anthropic",
			modelOverride: "claude-opus-4",
			dispatcherHandle: "@operator",
		});
		const id = created.planRun.id;
		await repos.planRuns.transitionTo(id, "running", {
			startedAt: new Date().toISOString(),
		});
		await repos.planRuns.transitionTo(id, "failed", {
			failureReason:
				"dispatch_failed:WarrenConfigUnavailableError: project clone missing on disk: /data/projects/x/seedy",
			endedAt: new Date().toISOString(),
		});
		await repos.planRuns.updateChild({
			planRunId: id,
			seq: 1,
			patch: { state: "failed", failureReason: "host path /data/projects/x/seedy leaked" },
		});
		return id;
	}

	test("GET /plan-runs withholds redacted fields from an anonymous spectator", async () => {
		const id = await seedFailedPlanRun();
		await servePublic();

		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/plan-runs?state=failed`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { planRuns: Record<string, unknown>[] };
		expect(body.planRuns).toHaveLength(1);
		const row = body.planRuns[0] as Record<string, unknown>;
		expect(row.id).toBe(id);
		expect(row.state).toBe("failed");
		for (const redacted of REDACTED_PLAN_RUN_FIELDS) {
			expect(row).not.toHaveProperty(redacted);
		}
		expect(JSON.stringify(row)).not.toContain("/data/projects");
	});

	test("GET /plan-runs/:id withholds redacted fields on the row and children from a spectator", async () => {
		const id = await seedFailedPlanRun();
		await servePublic();

		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/plan-runs/${id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			planRun: Record<string, unknown>;
			children: Record<string, unknown>[];
		};
		for (const redacted of REDACTED_PLAN_RUN_FIELDS) {
			expect(body.planRun).not.toHaveProperty(redacted);
		}
		expect(body.children).toHaveLength(1);
		const child = body.children[0] as Record<string, unknown>;
		expect(child).not.toHaveProperty("failureReason");
		expect(child.state).toBe("failed");
		expect(JSON.stringify(body)).not.toContain("/data/projects");
	});

	test("the operator token still gets the full rows", async () => {
		const id = await seedFailedPlanRun();
		await servePublic();

		const res = await fetch(`${tcpUrl(handle as ServeHandle)}/plan-runs/${id}`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			planRun: Record<string, unknown>;
			children: Record<string, unknown>[];
		};
		expect(body.planRun.promptTemplate).toBe("work on sd {seed_id} SECRET-TEMPLATE");
		expect(body.planRun.dispatcherHandle).toBe("@operator");
		expect(body.planRun.failureReason).toContain("/data/projects/x/seedy");
		expect((body.children[0] as Record<string, unknown>).failureReason).toContain(
			"/data/projects/x/seedy",
		);
	});
});
