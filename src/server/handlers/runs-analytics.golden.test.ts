/**
 * Golden snapshots for the analytics GET bodies (warren-ea4e).
 *
 * `/analytics/runs` and `/analytics/cost` are stable wire surfaces the
 * UI and downstream consumers build panels on, so the full operator
 * bodies are pinned the same way the detail envelopes are: a real
 * server over a fixed in-memory fixture, deep-equalled against the
 * on-disk fixture under `__golden__/responses/`. Ids and timestamps are
 * pinned at insert time so the snapshots are deterministic. The body
 * covers the warren-ea4e additions — `totals.costUsd` (per-run cost
 * percentiles), `capHits` (budget.exceeded events), and `byCostBasis`.
 *
 * Regenerate with `WARREN_UPDATE_GOLDENS=1 bun test
 * src/server/handlers/runs-analytics.golden.test.ts`, then inspect the
 * diff and commit only what you meant.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, NO_AUTH, silentLogger, tcpUrl } from "./runs.analytics.test-helpers.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "responses");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

const PROJECT_ID = "project_golden_ea4e";
const RUN_API = "run_golden_ea4e_api";
const RUN_SUB = "run_golden_ea4e_sub";
const RUN_UNPRICED = "run_golden_ea4e_ghost";
const NOW = "2026-08-07T00:00:00.000Z";
// Pinned analytics window — the fixtures must not drift with the clock.
const WINDOW = "from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z";

interface Snapshot {
	readonly status: number;
	readonly body: unknown;
}

interface SeedSpec {
	readonly id: string;
	readonly costUsd: number | null;
	readonly state: "succeeded" | "failed" | "running";
	readonly costBasis: "api" | "subscription_estimate";
}

async function seedAnalyticsRun(repos: Repos, s: SeedSpec): Promise<void> {
	await repos.runs.create({
		id: s.id,
		agentName: "claude-code",
		projectId: PROJECT_ID,
		prompt: "pin the analytics body",
		renderedAgentJson: { frontmatter: { provider: "anthropic", model: "sonnet" } },
		trigger: "manual",
		now: new Date(NOW),
		costBasis: s.costBasis,
	});
	await repos.runs.markRunning(s.id, new Date("2026-08-07T00:00:05.000Z"));
	// A running row stays unpriced — terminal null-cost rows are zeroed by
	// the read-time hydration (warren-b33e), so the unpriced bucket needs a
	// non-terminal run to survive.
	if (s.state === "running") return;
	await repos.runs.finalize(
		s.id,
		s.state,
		new Date("2026-08-07T00:05:00.000Z"),
		s.state === "failed" ? "crashed" : null,
	);
	if (s.costUsd === null) return;
	await repos.runs.attachStats(s.id, {
		tokensInput: 1000,
		tokensCacheRead: 0,
		tokensOutput: 100,
		tokensCacheWrite: 0,
		costUsd: s.costUsd,
	});
}

describe("analytics GET bodies — __golden__ snapshots (warren-ea4e)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.projects.create({
			id: PROJECT_ID,
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
		});
		// One priced API run, one priced subscription-estimate run, and one
		// unpriced run that is still running — see seedAnalyticsRun.
		const seeds: readonly SeedSpec[] = [
			{ id: RUN_API, costUsd: 1.5, state: "succeeded", costBasis: "api" },
			{ id: RUN_SUB, costUsd: 0.75, state: "failed", costBasis: "subscription_estimate" },
			{ id: RUN_UNPRICED, costUsd: null, state: "running", costBasis: "api" },
		];
		for (const s of seeds) await seedAnalyticsRun(repos, s);
		// Two budget.exceeded events — the capHits count's only source.
		for (const [runId, seq] of [
			[RUN_API, 1],
			[RUN_SUB, 2],
		] as const) {
			await repos.events.append({
				runId,
				sandboxEventSeq: seq,
				ts: "2026-08-07T00:04:00.000Z",
				kind: "budget.exceeded",
				stream: "system",
				payload: { costUsd: 2, capUsd: 1 },
			});
		}
		handle = startServer(depsFor(repos), {
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
		{ name: "analytics-runs", path: `/analytics/runs?${WINDOW}` },
		{ name: "analytics-cost", path: `/analytics/cost?${WINDOW}` },
	];

	if (UPDATE) {
		test("regenerate fixtures", async () => {
			if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
			for (const c of cases) {
				const path = join(GOLDEN_DIR, `${c.name}.json`);
				writeFileSync(path, `${JSON.stringify(await produce(c.path), null, "\t")}\n`);
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

	test("the new economics fields carry the fixture figures (warren-ea4e)", async () => {
		const runs = (await produce(`/analytics/runs?${WINDOW}`)).body as {
			totals: { costUsd: { avg: number; median: number; p95: number; count: number } };
			capHits: number;
		};
		expect(runs.totals.costUsd).toEqual({ avg: 1.125, median: 0.75, p95: 1.5, count: 2 });
		expect(runs.capHits).toBe(2);
		const cost = (await produce(`/analytics/cost?${WINDOW}`)).body as {
			byCostBasis: { key: string; runs: number; costUsd: number }[];
		};
		expect(cost.byCostBasis).toEqual([
			{ key: "api", runs: 1, costUsd: 1.5 },
			{ key: "subscription_estimate", runs: 1, costUsd: 0.75 },
			{ key: "unpriced", runs: 1, costUsd: 0 },
		]);
	});
});
