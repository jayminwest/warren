import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getTableColumns } from "drizzle-orm";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { type RunRow, runs } from "../../db/schema.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { PUBLIC_RUN_FIELDS, REDACTED_RUN_FIELDS } from "./runs/lifecycle.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * Public projections for `GET /runs` and `GET /runs/:id` (warren-946f /
 * pl-b82d step 14).
 *
 * The classification is asserted twice over: as data (every `runs` column
 * lands in exactly one of the two exported lists, so a new column fails
 * this file until someone classifies it) and over the wire against a real
 * server under `WARREN_AUTH=public`, anonymously and with the operator
 * token, so the "operator is unchanged" half is proved rather than assumed.
 */

const TOKEN = "s3cret";

/** A burrow client that 404s everything — no route here reaches it. */
function inertSandboxClient(): FakeProvider {
	return new FakeProvider();
}

describe("run field classification (warren-946f)", () => {
	const columns = Object.keys(getTableColumns(runs)) as (keyof RunRow)[];

	test("every runs column is classified exactly once", () => {
		const classified = [...PUBLIC_RUN_FIELDS, ...REDACTED_RUN_FIELDS];
		expect([...classified].sort()).toEqual([...columns].sort());
		expect(new Set(classified).size).toBe(classified.length);
	});

	test("the redacted set is exactly the fields pl-b82d named", () => {
		expect([...REDACTED_RUN_FIELDS].sort()).toEqual([
			"previewFailureMessage",
			"renderedAgentJson",
			// warren-cd3b: a host filesystem path is internal topology.
			"salvagePath",
			"sandboxId",
			"sandboxRunId",
			"workerId",
		]);
	});

	test("the prompt and per-run cost are deliberately public", () => {
		for (const kept of [
			"prompt",
			"costUsd",
			"tokensInput",
			"tokensOutput",
			"tokensCacheRead",
			"tokensCacheWrite",
			"state",
			"failureReason",
			"agentName",
			"projectId",
			"seedId",
			"targetBranch",
			"prUrl",
			"startedAt",
			"endedAt",
		] as const) {
			expect(PUBLIC_RUN_FIELDS).toContain(kept);
		}
	});
});

describe("GET /runs projections under WARREN_AUTH=public (warren-946f)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;
	let runId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
		});
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: project.id,
			prompt: "fix the flaky test",
			renderedAgentJson: { frontmatter: { provider: "anthropic", model: "opus" } },
			trigger: "manual",
			sandboxId: "bur_1",
			sandboxRunId: "burun_1",
			workerId: "worker_1",
		});
		runId = row.id;
		await repos.runs.markRunning(runId, new Date("2026-07-01T00:00:00.000Z"));
		await repos.runs.finalize(runId, "succeeded", new Date("2026-07-01T00:05:00.000Z"), null);
		await repos.runs.attachStats(runId, { costUsd: 1.25, tokensInput: 100, tokensOutput: 20 });
		await repos.runs.attachPreview(runId, {
			previewState: "failed",
			previewFailureMessage: "bun install exited 1: EACCES /root/.bun",
		});
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

	test("anonymous GET /runs emits exactly the public field set", async () => {
		const body = await get("/runs");
		const list = body.runs as Record<string, unknown>[];
		expect(list).toHaveLength(1);
		expect(Object.keys(list[0] ?? {}).sort()).toEqual([...PUBLIC_RUN_FIELDS].sort());
	});

	test("anonymous GET /runs drops the instance-wide cost rollup", async () => {
		const body = await get("/runs");
		expect(body).not.toHaveProperty("costTotalUsd");
		expect(body.total).toBe(1);
		expect(body.limit).toBe(100);
		expect(body.offset).toBe(0);
	});

	test("anonymous GET /runs keeps the prompt and per-run cost", async () => {
		const body = await get("/runs");
		const run = (body.runs as Record<string, unknown>[])[0];
		expect(run?.prompt).toBe("fix the flaky test");
		expect(run?.costUsd).toBe(1.25);
		expect(run?.tokensInput).toBe(100);
		expect(run?.state).toBe("succeeded");
	});

	test("anonymous GET /runs/:id round-trips the dispatch-supplied ref (warren-afeb)", async () => {
		const project = (await repos.projects.listAll())[0];
		if (!project) throw new Error("project missing");
		const row = await repos.runs.create({
			agentName: "claude-code",
			projectId: project.id,
			prompt: "repair the PR",
			renderedAgentJson: { frontmatter: {} },
			trigger: "manual",
			ref: "fix/pr-head",
		});
		const body = await get(`/runs/${row.id}`);
		expect((body.run as Record<string, unknown>).ref).toBe("fix/pr-head");
		// The ref-less sibling row reads null, never undefined/absent.
		const other = await get(`/runs/${runId}`);
		expect((other.run as Record<string, unknown>).ref).toBeNull();
	});

	test("anonymous GET /runs/:id wraps the public field set in {run} (warren-7d84)", async () => {
		const body = await get(`/runs/${runId}`);
		expect(Object.keys(body)).toEqual(["run"]);
		const run = body.run as Record<string, unknown>;
		expect(Object.keys(run).sort()).toEqual([...PUBLIC_RUN_FIELDS].sort());
		for (const dropped of REDACTED_RUN_FIELDS) {
			expect(run).not.toHaveProperty(dropped);
		}
	});

	test("no redacted value survives anywhere in an anonymous body", async () => {
		const listed = JSON.stringify(await get("/runs"));
		const detail = JSON.stringify(await get(`/runs/${runId}`));
		for (const secret of ["bur_1", "burun_1", "worker_1", "EACCES", "anthropic"]) {
			expect(listed).not.toContain(secret);
			expect(detail).not.toContain(secret);
		}
	});

	test("the operator body is the full row plus the cost rollup and cap overlay (warren-f8a2)", async () => {
		const stored = await repos.runs.require(runId);
		const body = await get("/runs", TOKEN);
		const list = body.runs as Record<string, unknown>[];
		// The list overlays the dispatch-context spend cap and runtime backend
		// on each row — fields the stored row itself does not carry. No context
		// row exists for this run, so both read null, never absent.
		expect(new Set(Object.keys(list[0] ?? {}))).toEqual(
			new Set([...Object.keys(stored), "maxCostUsd", "runtimeBackend"]),
		);
		expect(list[0]?.maxCostUsd).toBeNull();
		expect(list[0]?.runtimeBackend).toBeNull();
		expect(body.costTotalUsd).toBe(1.25);
		expect(body.costPricedCount).toBe(1);
		const detailBody = await get(`/runs/${runId}`, TOKEN);
		expect(Object.keys(detailBody)).toEqual(["run"]);
		const detail = detailBody.run as Record<string, unknown>;
		// The detail GET overlays the dispatch-context cap too (warren-b19e,
		// operator-only, for the Spend panel's "$X of $Y cap"). No context row
		// here, so it reads null, never absent.
		expect(new Set(Object.keys(detail))).toEqual(new Set([...Object.keys(stored), "maxCostUsd"]));
		expect(detail.maxCostUsd).toBeNull();
		expect(detail.sandboxId).toBe("bur_1");
		expect(detail.renderedAgentJson).toEqual({
			frontmatter: { provider: "anthropic", model: "opus" },
		});
	});

	test("the operator list carries the dispatch-context facts; spectators never do (warren-f8a2 / warren-a0f4)", async () => {
		await repos.dispatchContext.insert({
			runId,
			createdAt: "2026-07-01T00:00:00.000Z",
			maxCostUsd: 5,
			runtimeBackend: "k8s",
		});
		const authed = await get("/runs", TOKEN);
		expect((authed.runs as Record<string, unknown>[])[0]?.maxCostUsd).toBe(5);
		expect((authed.runs as Record<string, unknown>[])[0]?.runtimeBackend).toBe("k8s");
		// warren-b19e: the detail GET carries the cap too (the Spend panel's
		// "$X of $Y cap" denominator), still operator-only.
		const detailWithCap = (await get(`/runs/${runId}`, TOKEN)).run as Record<string, unknown>;
		expect(detailWithCap.maxCostUsd).toBe(5);
		const anonDetail = (await get(`/runs/${runId}`)).run as Record<string, unknown>;
		expect(anonDetail).not.toHaveProperty("maxCostUsd");
		const anon = await get("/runs");
		expect((anon.runs as Record<string, unknown>[])[0]).not.toHaveProperty("maxCostUsd");
		expect((anon.runs as Record<string, unknown>[])[0]).not.toHaveProperty("runtimeBackend");
	});

	test("the operator envelope keeps its historical key order", async () => {
		const body = await get("/runs", TOKEN);
		expect(Object.keys(body)).toEqual([
			"runs",
			"total",
			"costTotalUsd",
			"costPricedCount",
			"limit",
			"offset",
		]);
	});
});
