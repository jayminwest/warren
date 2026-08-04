import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WarrenHttpError, createClient, listRuns, readEventsSince } from "./client.ts";
import { FakeWarren } from "./fake-warren.ts";
import { WireDriftError, parseRunEvent, parseRunListRow } from "./wire.ts";

describe("warren HTTP client", () => {
	let fake: FakeWarren;
	beforeEach(() => {
		fake = new FakeWarren();
		fake.start();
	});
	afterEach(() => fake.stop());

	test("listRuns pages with limit/offset and sends the bearer token", async () => {
		for (let i = 0; i < 7; i++) {
			fake.addRun({ id: `r${i}`, state: "running", startedAt: `2026-08-04T00:00:0${i}Z` });
		}
		const client = createClient({ baseUrl: fake.baseUrl, token: "secret-token" });

		const page1 = await listRuns(client, { limit: 5, offset: 0 });
		const page2 = await listRuns(client, { limit: 5, offset: 5 });

		expect(page1.runs.map((r) => r.id)).toEqual(["r6", "r5", "r4", "r3", "r2"]);
		expect(page2.runs.map((r) => r.id)).toEqual(["r1", "r0"]);
		expect(page1.total).toBe(7);
		expect(fake.lastAuthorization).toBe("Bearer secret-token");
	});

	test("listRuns tolerates additive fields on run rows", async () => {
		fake.addRun({ id: "r1", state: "queued", startedAt: "2026-08-04T00:00:00Z" });
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		const page = await listRuns(client, { limit: 10, offset: 0 });
		expect(page.runs).toEqual([{ id: "r1", state: "queued" }]);
	});

	test("readEventsSince pages events with an exclusive since cursor", async () => {
		fake.addRun({ id: "r1", state: "running", startedAt: "2026-08-04T00:00:00Z" });
		for (let seq = 1; seq <= 5; seq++) {
			fake.addEvent("r1", {
				id: seq,
				seq,
				ts: "2026-08-04T00:00:00Z",
				kind: "message",
				stream: "stdout",
				payload: { n: seq },
			});
		}
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });

		const page = await readEventsSince(client, "r1", { since: 2, limit: 2 });
		expect(page.map((e) => e.seq)).toEqual([3, 4]);
		expect(page[2 - 2]?.payload).toEqual({ n: 3 });

		const rest = await readEventsSince(client, "r1", { since: 4, limit: 500 });
		expect(rest.map((e) => e.seq)).toEqual([5]);
	});

	test("readEventsSince returns an empty page when caught up", async () => {
		fake.addRun({ id: "r1", state: "succeeded", startedAt: "2026-08-04T00:00:00Z" });
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		expect(await readEventsSince(client, "r1", { since: 0, limit: 500 })).toEqual([]);
	});

	test("readEventsSince URL-encodes run ids", async () => {
		fake.addRun({ id: "run 1/x", state: "running", startedAt: "2026-08-04T00:00:00Z" });
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		const events = await readEventsSince(client, "run 1/x", { since: 0, limit: 10 });
		expect(events).toEqual([]);
	});

	test("a non-2xx raises WarrenHttpError with status and no token", async () => {
		fake.failWithStatus = 401;
		const client = createClient({ baseUrl: fake.baseUrl, token: "secret-token" });
		const err = await listRuns(client, { limit: 1, offset: 0 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WarrenHttpError);
		expect((err as WarrenHttpError).status).toBe(401);
		expect((err as WarrenHttpError).message).not.toContain("secret-token");
	});

	test("a 404 on the events route raises WarrenHttpError", async () => {
		const client = createClient({ baseUrl: fake.baseUrl, token: "t" });
		const err = await readEventsSince(client, "ghost", { since: 0, limit: 1 }).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(WarrenHttpError);
		expect((err as WarrenHttpError).status).toBe(404);
	});
});

describe("wire parsing (the hand-derived contract)", () => {
	test("parseRunListRow rejects a state outside the known vocabulary", () => {
		expect(() => parseRunListRow({ id: "r1", state: "vibing" })).toThrow(WireDriftError);
	});

	test("parseRunListRow rejects non-object rows", () => {
		expect(() => parseRunListRow("r1")).toThrow(WireDriftError);
	});

	test("parseRunEvent narrows the seven-key envelope", () => {
		const event = parseRunEvent({
			id: 1,
			runId: "r1",
			seq: 42,
			ts: "2026-08-04T00:00:00Z",
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
