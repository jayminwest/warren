/**
 * Golden snapshot tests for the detail-GET envelope convention
 * (warren-7d84).
 *
 * The convention: a detail GET wraps its resource. `GET /runs/:id`
 * returns `{run}` — matching `POST /runs` — and `GET /plan-runs/:id`
 * returns `{planRun, children, runs}`, matching `POST /plan-runs`. Before
 * this pin, `GET /runs/:id` served the row bare, so a consumer guessing
 * the wrong envelope read all-null and dispatched duplicates (twice).
 *
 * Each case boots a real server over a fixed in-memory fixture and
 * deep-equals the live `{status, body}` against the on-disk fixture
 * under `__golden__/envelopes/<name>.json`. All ids and timestamps are
 * pinned at insert time so the snapshot is deterministic.
 *
 * Regenerate after an intentional shape change with
 * `WARREN_UPDATE_GOLDENS=1 bun test
 * src/server/handlers/detail-envelopes.golden.test.ts`, then diff the
 * fixtures and commit only what you meant.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "envelopes");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

const RUN_ID = "run_golden7d84";
const PLAN_RUN_ID = "planRun_golden7d84";
const NOW = new Date("2026-08-07T00:00:00.000Z");

interface Snapshot {
	readonly status: number;
	readonly body: unknown;
}

describe("detail-GET envelopes — __golden__ snapshots (warren-7d84)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			id: "project_golden7d84",
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
		});
		await repos.runs.create({
			id: RUN_ID,
			agentName: "claude-code",
			projectId: project.id,
			prompt: "pin the detail envelope",
			renderedAgentJson: { frontmatter: { provider: "anthropic", model: "opus" } },
			trigger: "manual",
			now: NOW,
		});
		await repos.runs.markRunning(RUN_ID, NOW);
		await repos.runs.finalize(RUN_ID, "succeeded", new Date("2026-08-07T00:05:00.000Z"), null);
		await repos.planRuns.create({
			id: PLAN_RUN_ID,
			planId: "pl-golden7d84",
			projectId: project.id,
			agentName: "claude-code",
			children: [
				{ seq: 1, seedId: "wa-golden-a" },
				{ seq: 2, seedId: "wa-golden-b" },
			],
			now: NOW,
		});
		handle = startServer(await depsFor(repos, new FakeProvider()), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
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

	async function produce(path: string): Promise<Snapshot> {
		const res = await fetch(`${base}${path}`);
		return { status: res.status, body: await res.json() };
	}

	const cases: ReadonlyArray<{ name: string; path: string }> = [
		{ name: "run-detail", path: `/runs/${RUN_ID}` },
		{ name: "plan-run-detail", path: `/plan-runs/${PLAN_RUN_ID}` },
	];

	if (UPDATE) {
		test("regenerate fixtures", async () => {
			if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
			for (const c of cases) {
				const path = join(GOLDEN_DIR, `${c.name}.json`);
				const formatted = `${JSON.stringify(await produce(c.path), null, "\t")}\n`;
				writeFileSync(path, formatted);
			}
			expect(cases.length).toBeGreaterThan(0);
		});
		return;
	}

	for (const c of cases) {
		test(c.name, async () => {
			const path = join(GOLDEN_DIR, `${c.name}.json`);
			const expected = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
			expect(await produce(c.path)).toEqual(expected);
		});
	}

	test("both detail GETs wrap their resource (the convention, in one assertion)", async () => {
		const runBody = (await produce(`/runs/${RUN_ID}`)).body as Record<string, unknown>;
		expect(Object.keys(runBody)).toEqual(["run"]);
		const planBody = (await produce(`/plan-runs/${PLAN_RUN_ID}`)).body as Record<string, unknown>;
		expect(Object.keys(planBody).sort()).toEqual(["children", "planRun", "runs"]);
	});
});
