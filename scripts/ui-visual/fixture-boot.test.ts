import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUN_STATES } from "../../src/core/wire.ts";
import { openDatabase } from "../../src/db/client.ts";
import { createRepos } from "../../src/db/repos/index.ts";
import { BUILTIN_AGENTS } from "../../src/registry/builtins/index.ts";
import { bootFixture, type FixtureBootHandle } from "./fixture-boot.ts";
import { FIXTURE_NOW_ISO, FIXTURE_NOW_MS, FIXTURE_TOKEN, seedFixtureDb } from "./fixture-data.ts";

/** Spec budget (warren-010b): seed + boot to a healthy server in under 10s. */
const BOOT_BUDGET_MS = 10_000;
const MINUTE_MS = 60_000;

let fixture: FixtureBootHandle;
let bootMs = 0;

async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${fixture.output.baseUrl}${path}`, {
		headers: { authorization: `Bearer ${FIXTURE_TOKEN}` },
	});
	if (res.status !== 200) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
	return (await res.json()) as T;
}

interface RunBody {
	readonly run: {
		readonly id: string;
		readonly state: string;
		readonly failureReason: string | null;
		readonly prUrl: string | null;
		readonly prState: string | null;
		readonly createdAt: number;
		readonly startedAt: string | null;
	};
}

beforeAll(async () => {
	const started = performance.now();
	// API only: the test must not depend on a `bun run build:ui` artifact.
	fixture = await bootFixture({ uiDistDir: null });
	bootMs = performance.now() - started;
});

afterAll(async () => {
	await fixture?.stop();
});

describe("bootFixture", () => {
	test("boots within the budget and reports the fixed token and frozen clock", () => {
		expect(bootMs).toBeLessThan(BOOT_BUDGET_MS);
		expect(fixture.output.token).toBe(FIXTURE_TOKEN);
		expect(fixture.output.frozenNow).toBe(FIXTURE_NOW_ISO);
		expect(fixture.output.frozenNowMs).toBe(FIXTURE_NOW_MS);
		expect(fixture.output.uiServed).toBe(false);
	});

	test("pins the ids contract to fixed literals", () => {
		const { ids } = fixture.output;
		expect(ids.projects.withSeeds.id).toBe("prj_fx0000000001");
		expect(ids.projects.withoutSeeds.id).toBe("prj_fx0000000002");
		expect(ids.runs).toEqual({
			queued: "run_fx0000000101",
			running: "run_fx0000000102",
			succeeded: "run_fx0000000103",
			failed: "run_fx0000000104",
			cancelled: "run_fx0000000105",
			prOpen: "run_fx0000000106",
		});
		expect(ids.planRun.id).toBe("plnr_fx0000000001");
		expect(ids.planRun.children.length).toBeGreaterThanOrEqual(6);
		expect(ids.agents.builtin).toEqual(BUILTIN_AGENTS.map((a) => a.name));
		expect(ids.agents.legacyLibrary).toBe("legacy-reviewer");
		expect(ids.events.runId).toBe(ids.runs.running);
	});

	test("serves one run per wire lifecycle state plus an open-PR run", async () => {
		const { runs, failedRunReason } = fixture.output.ids;
		for (const state of RUN_STATES) {
			const { run } = await get<RunBody>(`/runs/${runs[state]}`);
			expect(run.state).toBe(state);
		}
		const failed = await get<RunBody>(`/runs/${runs.failed}`);
		expect(failed.run.failureReason).toBe(failedRunReason);
		const prOpen = await get<RunBody>(`/runs/${runs.prOpen}`);
		expect(prOpen.run.state).toBe("succeeded");
		expect(prOpen.run.prState).toBe("open");
		expect(prOpen.run.prUrl).toContain("/pull/");
		const list = await get<{ runs: { id: string }[] }>("/runs?limit=100");
		const listed = new Set(list.runs.map((r) => r.id));
		for (const id of Object.values(runs)) expect(listed.has(id)).toBe(true);
	});

	test("serves the plan-run with mixed child states and linked runs", async () => {
		const { planRun } = fixture.output.ids;
		const body = await get<{
			planRun: { id: string; state: string };
			children: { seq: number; state: string; runId: string | null }[];
			runs: { id: string }[];
		}>(`/plan-runs/${planRun.id}`);
		expect(body.planRun.state).toBe("running");
		expect(body.children.map((c) => c.state)).toEqual(planRun.children.map((c) => c.state));
		expect(new Set(body.children.map((c) => c.state)).size).toBeGreaterThanOrEqual(5);
		expect(body.runs.length).toBe(planRun.children.filter((c) => c.runId !== null).length);
	});

	test("lists the seven builtin agents and the legacy library row", async () => {
		const { agents } = await get<{ agents: { name: string; source: string }[] }>("/agents");
		const sourceOf = new Map(agents.map((a) => [a.name, a.source]));
		for (const name of fixture.output.ids.agents.builtin)
			expect(sourceOf.get(name)).toBe("builtin");
		expect(sourceOf.get(fixture.output.ids.agents.legacyLibrary)).toBe("library");
	});

	test("carries 40+ events on the running run across every stream", async () => {
		const { runId, count } = fixture.output.ids.events;
		const body = await get<{ events: { kind: string; stream: string }[]; total: number }>(
			`/events?run=${runId}&limit=200`,
		);
		expect(count).toBeGreaterThanOrEqual(40);
		expect(body.total).toBe(count);
		expect(new Set(body.events.map((e) => e.stream))).toEqual(
			new Set(["stdout", "stderr", "system"]),
		);
		const kinds = new Set(body.events.map((e) => e.kind));
		for (const kind of ["tool_use", "tool_result", "text", "stderr", "steer.sent"]) {
			expect(kinds.has(kind)).toBe(true);
		}
	});

	test("feeds every Telemetry tab non-empty data", async () => {
		const runsA = await get<{ totals: { runs: number; succeeded: number; failed: number } }>(
			"/analytics/runs",
		);
		expect(runsA.totals.runs).toBeGreaterThanOrEqual(20);
		expect(runsA.totals.failed).toBeGreaterThan(0);
		const cost = await get<{ totals: { costUsd: number } }>("/analytics/cost");
		expect(cost.totals.costUsd).toBeGreaterThan(0);
		const behavior = await get<{ mining: { totals: { toolUses: number; failures: number } } }>(
			"/analytics/behavior",
		);
		expect(behavior.mining.totals.toolUses).toBeGreaterThan(0);
		expect(behavior.mining.totals.failures).toBeGreaterThan(0);
		const judge = await fetch(
			`${fixture.output.baseUrl}/extensions/judge/verdicts.jsonl?limit=500&order=desc`,
			{ headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } },
		);
		expect(judge.status).toBe(200);
		const rows = (await judge.text()).trim().split("\n");
		expect(rows.length).toBe(fixture.output.ids.telemetry.judgeRows);
		const ops = await get<{ spend: { windowUsd: number } }>("/ops/overview");
		expect(ops.spend.windowUsd).toBeGreaterThan(0);
	});

	test("answers the seeds project's tracker reads without a 5xx", async () => {
		const { projects, tracker, planRun } = fixture.output.ids;
		const plans = await get<{ plans: { id: string }[] }>(
			`/projects/${projects.withSeeds.id}/seeds/plans`,
		);
		expect(plans.plans.map((p) => p.id)).toEqual([tracker.dispatchedPlanId, tracker.readyPlanId]);
		const child = planRun.children[0];
		const seed = await get<{ id?: string }>(
			`/projects/${projects.withSeeds.id}/seeds/${child?.seedId}`,
		);
		expect(JSON.stringify(seed)).toContain(child?.seedId ?? "?");
	});

	test("anchors server-side windows and seeded timestamps on the frozen clock", async () => {
		// No ?from/?to: the server resolves its default window from `deps.now`.
		const cost = await get<{ filter: { to: string } }>("/analytics/cost");
		expect(cost.filter.to).toBe(FIXTURE_NOW_ISO);
		// "8m ago" stays "8m ago" on every boot: the running run started at a fixed offset.
		const { run } = await get<RunBody>(`/runs/${fixture.output.ids.runs.running}`);
		expect(FIXTURE_NOW_MS - Date.parse(run.startedAt ?? "")).toBe(8 * MINUTE_MS);
		expect(FIXTURE_NOW_MS - run.createdAt).toBe(9 * MINUTE_MS);
	});
});

describe("seedFixtureDb", () => {
	test("writes byte-identical rows on every seed", async () => {
		const roots = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), "warren-fx-seed-"))));
		try {
			const dumps: string[] = [];
			for (const root of roots) {
				const project = join(tmpdir(), "warren-fx-seed-shared-path");
				const result = await seedFixtureDb({
					dbPath: join(root, "warren.db"),
					seedsProjectPath: project,
					plainProjectPath: project,
				});
				const db = await openDatabase({ path: join(root, "warren.db"), skipMigrations: true });
				try {
					const repos = createRepos(db);
					const runs = await repos.runs.listByIds([
						...Object.values(result.ids.runs),
						...result.ids.telemetry.historyRunIds,
					]);
					const events = await repos.events.listByRun(result.ids.events.runId);
					dumps.push(JSON.stringify({ ids: result.ids, runs, events }));
				} finally {
					await db.close();
				}
			}
			expect(dumps[0]).toBe(dumps[1]);
		} finally {
			for (const root of roots) await rm(root, { recursive: true, force: true });
			await rm(join(tmpdir(), "warren-fx-seed-shared-path"), { recursive: true, force: true });
		}
	});
});

describe("FixtureBootHandle.stop", () => {
	test("shuts warren down and removes the temp root", async () => {
		const handle = await bootFixture({ uiDistDir: null });
		const { baseUrl, tmpRoot } = handle.output;
		expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
		await handle.stop();
		await expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow();
		expect(existsSync(tmpRoot)).toBe(false);
		await handle.stop(); // idempotent
	}, 30_000);
});
