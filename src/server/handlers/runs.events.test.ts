import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import {
	EVENT_STREAM_RETRY_AFTER_SECONDS,
	EventStreamLimiter,
	type EventStreamLimits,
} from "../stream-limits.ts";
import type { Logger, ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

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
			sandboxEventSeq: 1,
			ts: "2026-05-08T12:00:00Z",
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "bash" },
		});
		await repos.events.append({
			runId: run.id,
			sandboxEventSeq: 2,
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
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		// Explicit follow=0: as of warren-7bff a bare request on a
		// non-terminal run follows instead of replay-then-close.
		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events?follow=0`);
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

	test("?limit=N returns a bounded read and closes (warren-17c1)", async () => {
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		// The run is non-terminal, so without ?limit this request would
		// follow and hang (warren-7bff). limit implies follow=false.
		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events?limit=1`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/x-ndjson");
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		expect(lines.length).toBe(1);
		const first = JSON.parse(lines[0] ?? "{}") as { kind: string; seq: number };
		expect(first.kind).toBe("tool_use");
		expect(first.seq).toBe(1);
	});

	test("?limit wins over an explicit ?follow=1 (warren-17c1)", async () => {
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		// follow=1 on a non-terminal run would hold the stream open; the
		// bounded read must still close after at most N events.
		const res = await fetch(`${tcpUrl(handle)}/runs/${run.id}/events?follow=1&limit=2`);
		expect(res.status).toBe(200);
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		expect(lines.length).toBe(2);
	});

	test("?limit rejects garbage and zero (warren-17c1)", async () => {
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		for (const raw of ["abc", "0", "-3", "1.5"]) {
			const res = await fetch(
				`${tcpUrl(handle)}/runs/${run.id}/events?limit=${encodeURIComponent(raw)}`,
			);
			expect(res.status).toBe(400);
		}
	});

	test("404 on unknown run id", async () => {
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
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
			sandboxEventSeq: 1,
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
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient, undefined, {
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
		const url = await serve({
			maxGlobal: 0,
			maxPerClient: 2,
			maxLifetimeMs: 0,
			trustedProxyHops: 0,
		});

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
			{ maxGlobal: 1, maxPerClient: 0, maxLifetimeMs: 0, trustedProxyHops: 0 },
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
		const url = await serve({
			maxGlobal: 1,
			maxPerClient: 1,
			maxLifetimeMs: 0,
			trustedProxyHops: 0,
		});
		// Non-follow: the handler replays history and closes, so the slot is
		// released through `asNdjsonStream`'s end-of-source path.
		const historyUrl = url.replace("?follow=1", "?follow=0");
		expect((await fetch(historyUrl).then((r) => r.text())).trim()).not.toBe("");
		const second = await fetch(historyUrl);
		expect(second.status).toBe(200);
		await second.text();
	});
});

/**
 * warren-7bff: a bare `GET /runs/:id/events` (no `?follow=`) on a
 * NON-TERMINAL run follows — holds the connection and streams events
 * ingested after connect, closing when the run goes terminal. Observed on
 * app.warren.run (k8s, 0.13.0): authenticated `curl -N` replayed persisted
 * events and exited in <1s against a state=running run, breaking the
 * RUNBOOK-K8S >30s Ingress stream verification.
 */
describe("GET /runs/:id/events — follow-by-default on live runs (warren-7bff)", () => {
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
			sandboxEventSeq: 1,
			ts: "2026-05-08T12:00:00Z",
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "bash" },
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function serve(): Promise<{ url: string; runId: string; deps: ServerDeps }> {
		const sandboxClient = new FakeProvider();
		const deps = await depsFor(repos, sandboxClient);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const run = (await repos.runs.listAll())[0];
		if (!run) throw new Error("run missing");
		return { url: `${tcpUrl(handle)}/runs/${run.id}/events`, runId: run.id, deps };
	}

	/** Read one NDJSON line from a streaming response body. */
	async function readLine(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		buf: { text: string },
	): Promise<string> {
		const decoder = new TextDecoder();
		while (!buf.text.includes("\n")) {
			const { done, value } = await reader.read();
			if (done) throw new Error("stream closed before a full line arrived");
			buf.text += decoder.decode(value, { stream: true });
		}
		const idx = buf.text.indexOf("\n");
		const line = buf.text.slice(0, idx);
		buf.text = buf.text.slice(idx + 1);
		return line;
	}

	test("bare request on a non-terminal run receives events appended after connect", async () => {
		const { url, runId, deps } = await serve();
		const res = await fetch(url);
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("expected a streaming body");
		const buf = { text: "" };
		try {
			// Replayed history arrives first...
			const first = JSON.parse(await readLine(reader, buf)) as { seq: number };
			expect(first.seq).toBe(1);
			// ...then an event ingested AFTER the connect is delivered live —
			// the pre-fix behavior closed the stream after the replay.
			const row = await repos.events.append({
				runId,
				sandboxEventSeq: 2,
				ts: "2026-05-08T12:00:01Z",
				kind: "tool_result",
				stream: "stdout",
				payload: { ok: true },
			});
			deps.broker.publish(runId, row);
			const second = JSON.parse(await readLine(reader, buf)) as { seq: number; kind: string };
			expect(second.seq).toBe(2);
			expect(second.kind).toBe("tool_result");
		} finally {
			await reader.cancel().catch(() => {});
		}
	});

	test("follow tail closes promptly when the run reaches a terminal state", async () => {
		const { url, runId } = await serve();
		const res = await fetch(url);
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("expected a streaming body");
		const buf = { text: "" };
		try {
			await readLine(reader, buf);
			// Terminal transition with NO live bridge to `broker.close` the
			// tail — the handler's terminal backstop must end the stream.
			await repos.runs.markRunning(runId);
			await repos.runs.finalize(runId, "succeeded");
			const deadline = Date.now() + 4000;
			let closed = false;
			while (Date.now() < deadline) {
				const { done } = await reader.read();
				if (done) {
					closed = true;
					break;
				}
			}
			expect(closed).toBe(true);
		} finally {
			await reader.cancel().catch(() => {});
		}
	});

	test("bare request on a terminal run replays history and closes", async () => {
		const { url, runId } = await serve();
		await repos.runs.markRunning(runId);
		await repos.runs.finalize(runId, "succeeded");
		const res = await fetch(url);
		expect(res.status).toBe(200);
		// `res.text()` only resolves once the stream closes — a dangling
		// follow would time the test out instead.
		const text = await res.text();
		const lines = text
			.trim()
			.split("\n")
			.filter((l) => l !== "");
		expect(lines.length).toBe(1);
		expect((JSON.parse(lines[0] ?? "{}") as { seq: number }).seq).toBe(1);
	});
});
