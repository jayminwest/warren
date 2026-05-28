import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./runs.test-helpers.ts";

describe("GET /runs/:id/events — NDJSON tail", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "x", renderedJson: { name: "x" } });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "x",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: { name: "x", sections: { system: "x" } },
			trigger: "manual",
		});
		await repos.events.append({
			runId: run.id,
			burrowEventSeq: 1,
			ts: "2026-05-08T12:00:00Z",
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "bash" },
		});
		await repos.events.append({
			runId: run.id,
			burrowEventSeq: 2,
			ts: "2026-05-08T12:00:01Z",
			kind: "tool_result",
			stream: "stdout",
			payload: { ok: true },
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("non-follow returns the events as NDJSON", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		expect(lines.length).toBe(2);
		const first = JSON.parse(lines[0] ?? "{}") as { kind: string; seq: number };
		expect(first.kind).toBe("tool_use");
		expect(first.seq).toBe(1);
	});

	test("404 on unknown run id", async () => {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/run_unknown/events`);
		expect(res.status).toBe(404);
	});

	test("event envelopes carry the run's plotId (warren-a8c3)", async () => {
		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		// Backfill plot_id directly — the run was created before the project
		// flipped hasPlot. Spawn-side validation is covered by spawn.test.ts.
		db.raw.exec(`UPDATE runs SET plot_id = 'plot-2047abc1' WHERE id = '${run.id}'`);

		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events`);
		expect(res.status).toBe(200);
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		for (const line of lines) {
			const env = JSON.parse(line) as { plotId: string | null };
			expect(env.plotId).toBe("plot-2047abc1");
		}
	});

	test("plotId is null on the envelope when the run has no plot (warren-a8c3)", async () => {
		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");

		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events`);
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			const env = JSON.parse(line) as { plotId: string | null };
			expect(env.plotId).toBeNull();
		}
	});
});
