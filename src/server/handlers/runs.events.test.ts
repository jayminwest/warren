import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import {
	EVENT_STREAM_RETRY_AFTER_SECONDS,
	EventStreamLimiter,
	type EventStreamLimits,
} from "../stream-limits.ts";
import type { Logger, ServeHandle } from "../types.ts";
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
});

/**
 * Concurrency admission (warren-25f6). `idleTimeout: 0` plus a single-replica
 * control plane makes an uncapped `?follow=1` an unbounded connection sink;
 * these assert the caps refuse fast and never disturb the attached streams.
 */
describe("GET /runs/:id/events — concurrency caps", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	/** Held-open follow streams, drained in afterEach so no test leaks a socket. */
	let open: { reader: ReadableStreamDefaultReader<Uint8Array>; ctrl: AbortController }[] = [];

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
	});

	afterEach(async () => {
		for (const held of open) {
			await held.reader.cancel().catch(() => {});
			held.ctrl.abort();
		}
		open = [];
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function serve(limits: EventStreamLimits, logger: Logger = silentLogger): Promise<string> {
		const burrowClient = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => new Response("{}", { status: 200 })),
		});
		const deps = await depsFor(repos, burrowClient, undefined, {
			streamLimiter: new EventStreamLimiter(limits),
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger,
		});
		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		return `${tcpUrl(handle)}/runs/${run.id}/events?follow=1`;
	}

	/** Open a follow stream and read its first replayed NDJSON line. */
	async function openStream(url: string): Promise<{ status: number; firstLine: string }> {
		const ctrl = new AbortController();
		const res = await fetch(url, { signal: ctrl.signal });
		if (res.status !== 200) {
			await res.text();
			ctrl.abort();
			return { status: res.status, firstLine: "" };
		}
		const reader = res.body?.getReader();
		if (!reader) throw new Error("expected a streaming body");
		open.push({ reader, ctrl });
		const decoder = new TextDecoder();
		let buf = "";
		while (!buf.includes("\n")) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
		}
		return { status: res.status, firstLine: buf.split("\n")[0] ?? "" };
	}

	test("the N+1th stream for one client is refused while the first N keep delivering", async () => {
		const url = await serve({ maxGlobal: 0, maxPerClient: 2, maxLifetimeMs: 0 });

		const first = await openStream(url);
		const second = await openStream(url);
		for (const held of [first, second]) {
			expect(held.status).toBe(200);
			expect((JSON.parse(held.firstLine) as { kind: string }).kind).toBe("tool_use");
		}

		const refused = await fetch(url);
		expect(refused.status).toBe(503);
		expect(refused.headers.get("retry-after")).toBe(String(EVENT_STREAM_RETRY_AFTER_SECONDS));
		const body = (await refused.json()) as { error: { code: string } };
		expect(body.error.code).toBe("event_stream_capacity");

		// The refusal left the attached streams alone — both still tail live.
		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		expect(open).toHaveLength(2);
		expect(second.firstLine).toContain(run.id);
	});

	test("exceeding the instance-wide cap 503s and logs at warn", async () => {
		const lines: { level: string; obj: Record<string, unknown>; msg: string | undefined }[] = [];
		const record =
			(level: string) =>
			(obj: object, msg?: string): void => {
				lines.push({ level, obj: obj as Record<string, unknown>, msg });
			};
		const url = await serve(
			{ maxGlobal: 1, maxPerClient: 0, maxLifetimeMs: 0 },
			{ info: record("info"), warn: record("warn"), error: record("error") },
		);

		expect((await openStream(url)).status).toBe(200);
		const refused = await fetch(url);
		expect(refused.status).toBe(503);
		await refused.text();

		const warned = lines.filter((l) => l.msg === "event stream refused: instance at capacity");
		expect(warned).toHaveLength(1);
		expect(warned[0]?.level).toBe("warn");
		expect(warned[0]?.obj).toMatchObject({ route: "GET /runs/:id/events", scope: "global" });
	});

	test("a stream that ends normally gives its slot back", async () => {
		const url = await serve({ maxGlobal: 1, maxPerClient: 1, maxLifetimeMs: 0 });
		// Non-follow: the handler replays history and closes, so the slot is
		// released through `asNdjsonStream`'s end-of-source path.
		const historyUrl = url.replace("?follow=1", "");
		expect((await fetch(historyUrl).then((r) => r.text())).trim()).not.toBe("");
		const second = await fetch(historyUrl);
		expect(second.status).toBe(200);
		await second.text();
	});
});
