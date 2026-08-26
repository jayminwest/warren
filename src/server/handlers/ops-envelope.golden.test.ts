/**
 * Golden snapshot for the `GET /ops/overview` response envelope
 * (warren-d850 / pl-7e38 step 12).
 *
 * The Operations dashboard (warren-d903) polls this one endpoint for its
 * entire first paint, so the envelope (`{overview: {...}}`) and every
 * section inside it is a stable wire shape downstream consumers depend on.
 * This pins the full operator body — and the anonymous public projection —
 * as on-disk fixtures, deep-equal against a real server over a fixed
 * in-memory seed with a pinned clock (so the 24h spend window is
 * deterministic).
 *
 * Regenerate after an intentional shape change with
 * `WARREN_UPDATE_GOLDENS=1 bun test src/server/handlers/ops-envelope.golden.test.ts`,
 * then diff the fixtures and commit only what you meant.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { createBridgeRegistry } from "../bridges.ts";
import { createDbSeams } from "../db-seams.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "envelopes");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

const TOKEN = "ops-golden-token-0000000000000000000000000000";
/** Pinned clock: the spend window is measured against this instant. */
const NOW = new Date("2026-08-25T12:00:00.000Z");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

interface Snapshot {
	readonly status: number;
	readonly body: unknown;
}

async function depsFor(repos: Repos, db: WarrenDb): Promise<ServerDeps> {
	const provider = new FakeProvider();
	const broker = new RunEventBroker();
	return {
		repos,
		db,
		...createDbSeams(db),
		runtimeProvider: provider,
		forge: new FakeForge(),
		broker,
		bridges: createBridgeRegistry({
			repos,
			broker,
			runtimeProvider: provider,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		now: () => NOW,
	};
}

describe("GET /ops/overview envelope — __golden__ snapshot (warren-d850)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
		});
		// A shipped run: PR opened + merged + commits ahead, cost inside the window.
		const shipped = await repos.runs.create({
			agentName: "pi",
			projectId: project.id,
			prompt: "ship the widget",
			renderedAgentJson: { frontmatter: { provider: "openrouter", model: "test" } },
			trigger: "manual",
			now: NOW,
		});
		await repos.runs.markRunning(shipped.id, NOW);
		await repos.runs.finalize(shipped.id, "succeeded", new Date("2026-08-25T12:30:00.000Z"), null);
		await repos.runs.attachStats(shipped.id, {
			costUsd: 5.25,
			tokensInput: 1000,
			tokensOutput: 200,
			tokensCacheRead: 0,
		});
		await repos.runs.setPrUrl(shipped.id, "https://github.com/os-eco/warren/pull/42");
		await repos.runs.setPrState(shipped.id, "merged", "2026-08-25T13:00:00.000Z");
		await repos.runs.setOutcomeFacts(shipped.id, {
			commitsAhead: 2,
			filesChanged: 3,
			insertions: 40,
			deletions: 5,
		});
		// An old run: terminal 48h before the pinned clock, so its cost falls
		// outside the 24h spend window but inside the all-time total.
		const old = await repos.runs.create({
			agentName: "pi",
			projectId: project.id,
			prompt: "the earlier attempt",
			renderedAgentJson: { frontmatter: { provider: "openrouter", model: "test" } },
			trigger: "manual",
			now: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
		});
		await repos.runs.markRunning(old.id, NOW);
		await repos.runs.finalize(old.id, "failed", new Date("2026-08-23T13:00:00.000Z"), null);
		await repos.runs.attachStats(old.id, {
			costUsd: 100,
			tokensInput: 10000,
			tokensOutput: 2000,
			tokensCacheRead: 0,
		});
		// One pending steering intervention on the failed run.
		await repos.runInbox.enqueue({ runId: old.id, body: "stop and report", now: NOW });

		handle = startServer(await depsFor(repos, db), {
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

	function tcpUrl(h: ServeHandle): string {
		if (h.transport.kind !== "tcp") throw new Error("expected tcp transport");
		return `http://${h.transport.hostname}:${h.transport.port}`;
	}

	async function produce(path: string, token?: string): Promise<Snapshot> {
		const res = await fetch(
			`${base}${path}`,
			token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
		);
		return { status: res.status, body: await res.json() };
	}

	const cases: ReadonlyArray<{ name: string; path: string; token?: string }> = [
		{ name: "ops-overview-operator", path: "/ops/overview", token: TOKEN },
		{ name: "ops-overview-public", path: "/ops/overview" },
	];

	if (UPDATE) {
		test("regenerate fixtures", async () => {
			if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
			for (const c of cases) {
				const path = join(GOLDEN_DIR, `${c.name}.json`);
				const formatted = `${JSON.stringify(await produce(c.path, c.token), null, "\t")}\n`;
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
			expect(await produce(c.path, c.token)).toEqual(expected);
		});
	}

	test("the response wraps its snapshot in {overview} and the public body is the reduced projection", async () => {
		const operator = (await produce("/ops/overview", TOKEN)).body as Record<string, unknown>;
		expect(Object.keys(operator)).toEqual(["overview"]);
		const sections = Object.keys(operator.overview as object).sort();
		expect(sections).toEqual(["delivery", "health", "inbox", "runsByState", "spend"]);
		// No credential at all under publicReadAuth ⇒ the anonymous actor.
		const spectator = (await produce("/ops/overview")).body as Record<string, unknown>;
		expect(Object.keys(spectator.overview as object).sort()).toEqual(["delivery", "runsByState"]);
	});
});
