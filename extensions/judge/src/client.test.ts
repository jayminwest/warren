import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WarrenHttpError, createClient, getRun, listRuns, readEventsSince } from "./client.ts";
import { FakeWarren } from "./fake-warren.ts";
import {
	WireDriftError,
	isTerminalRunState,
	parseRunDetail,
	parseRunEvent,
	parseRunListRow,
} from "./warren-wire.ts";

describe("warren read client", () => {
	let fake: FakeWarren;
	beforeEach(() => {
		fake = new FakeWarren();
		fake.start();
	});
	afterEach(() => fake.stop());

	test("listRuns pages with limit/offset and sends the bearer token", async () => {
		for (let i = 0; i < 7; i++) {
			fake.addRun({ id: `r${i}`, state: "running", startedAt: `2026-08-15T00:00:0${i}Z` });
		}
		const client = createClient({ baseUrl: fake.baseUrl, token: "secret-token" });

		const page1 = await listRuns(client, { limit: 5, offset: 0 });
		const page2 = await listRuns(client, { limit: 5, offset: 5 });

		expect(page1.runs.map((r) => r.id)).toEqual(["r6", "r5", "r4", "r3", "r2"]);
		expect(page2.runs.map((r) => r.id)).toEqual(["r1", "r0"]);
		expect(page1.total).toBe(7);
		expect(fake.lastAuthorization).toBe("Bearer secret-token");
	});

	test("listRuns supports terminal-run discovery over the state field", async () => {
		fake.addRun({ id: "r1", state: "succeeded", startedAt: "2026-08-15T00:00:01Z" });
		fake.addRun({ id: "r2", state: "running", startedAt: "2026-08-15T00:00:02Z" });
		fake.addRun({ id: "r3", state: "failed", startedAt: "2026-08-15T00:00:03Z" });
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		const page = await listRuns(client, { limit: 100, offset: 0 });
		const terminal = page.runs.filter((r) => isTerminalRunState(r.state)).map((r) => r.id);
		expect(terminal).toEqual(["r3", "r1"]);
	});

	test("getRun unwraps the {run} envelope and parses the judge's facts", async () => {
		fake.addRun({
			id: "r1",
			state: "failed",
			startedAt: "2026-08-15T00:00:00Z",
			detail: {
				failureReason: "timed_out",
				costUsd: 1.25,
				prUrl: "https://github.com/acme/repo/pull/42",
				prState: "merged",
				prMergedAt: "2026-08-15T01:00:00Z",
				endedAt: "2026-08-15T00:30:00Z",
			},
		});
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		const run = await getRun(client, "r1");
		expect(run).toEqual({
			id: "r1",
			state: "failed",
			failureReason: "timed_out",
			costUsd: 1.25,
			prUrl: "https://github.com/acme/repo/pull/42",
			prState: "merged",
			prMergedAt: "2026-08-15T01:00:00Z",
			startedAt: "2026-08-15T00:00:00Z",
			endedAt: "2026-08-15T00:30:00Z",
		});
	});

	test("getRun reads null columns as none/unknown, never as zero", async () => {
		fake.addRun({ id: "r1", state: "succeeded", startedAt: "2026-08-15T00:00:00Z" });
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		const run = await getRun(client, "r1");
		expect(run.failureReason).toBeNull();
		expect(run.costUsd).toBeNull();
		expect(run.prUrl).toBeNull();
		expect(run.prState).toBeNull();
		expect(run.prMergedAt).toBeNull();
	});

	test("getRun URL-encodes run ids and 404s raise WarrenHttpError", async () => {
		fake.addRun({ id: "run 1/x", state: "queued", startedAt: "2026-08-15T00:00:00Z" });
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		expect((await getRun(client, "run 1/x")).id).toBe("run 1/x");
		const err = await getRun(client, "ghost").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WarrenHttpError);
		expect((err as WarrenHttpError).status).toBe(404);
	});

	test("readEventsSince pages events with an exclusive since cursor", async () => {
		fake.addRun({ id: "r1", state: "running", startedAt: "2026-08-15T00:00:00Z" });
		for (let seq = 1; seq <= 5; seq++) {
			fake.addEvent("r1", {
				id: seq,
				seq,
				ts: "2026-08-15T00:00:00Z",
				kind: "message",
				stream: "stdout",
				payload: { n: seq },
			});
		}
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });

		const page = await readEventsSince(client, "r1", { since: 2, limit: 2 });
		expect(page.map((e) => e.seq)).toEqual([3, 4]);
		expect(page[0]?.payload).toEqual({ n: 3 });

		const rest = await readEventsSince(client, "r1", { since: 4, limit: 500 });
		expect(rest.map((e) => e.seq)).toEqual([5]);
	});

	test("readEventsSince returns an empty page when caught up", async () => {
		fake.addRun({ id: "r1", state: "succeeded", startedAt: "2026-08-15T00:00:00Z" });
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		expect(await readEventsSince(client, "r1", { since: 0, limit: 500 })).toEqual([]);
	});

	test("a non-2xx raises WarrenHttpError with status and no token", async () => {
		fake.failWithStatus = 401;
		const client = createClient({ baseUrl: fake.baseUrl, token: "secret-token" });
		const err = await listRuns(client, { limit: 1, offset: 0 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WarrenHttpError);
		expect((err as WarrenHttpError).status).toBe(401);
		expect((err as WarrenHttpError).message).not.toContain("secret-token");
	});
});

describe("warren wire parsing (the hand-derived contract)", () => {
	test("parseRunListRow rejects a state outside the known vocabulary", () => {
		expect(() => parseRunListRow({ id: "r1", state: "vibing", startedAt: null })).toThrow(
			WireDriftError,
		);
	});

	test("parseRunDetail requires the {run} envelope, never the bare body", () => {
		expect(() => parseRunDetail({ id: "r1", state: "succeeded" })).toThrow(WireDriftError);
	});

	test("parseRunDetail rejects an unknown failureReason or prState", () => {
		const base = { id: "r1", state: "failed" };
		expect(() => parseRunDetail({ run: { ...base, failureReason: "aliens" } })).toThrow(
			WireDriftError,
		);
		expect(() => parseRunDetail({ run: { ...base, prState: "yoinked" } })).toThrow(
			WireDriftError,
		);
	});

	test("parseRunEvent narrows the seven-key envelope", () => {
		const event = parseRunEvent({
			id: 1,
			runId: "r1",
			seq: 42,
			ts: "2026-08-15T00:00:00Z",
			kind: "state_change",
			stream: "system",
			payload: { state: "running" },
		});
		expect(event.seq).toBe(42);
		expect(event.stream).toBe("system");
	});

	test("parseRunEvent accepts a null stream and rejects a numeric one", () => {
		expect(
			parseRunEvent({ id: 1, runId: "r", seq: 1, ts: "t", kind: "k", stream: null }).stream,
		).toBeNull();
		expect(() =>
			parseRunEvent({ id: 1, runId: "r", seq: 1, ts: "t", kind: "k", stream: 3 }),
		).toThrow(WireDriftError);
	});
});
