/**
 * Contract tests for the V0 Warren HTTP client (warren-a732) against the
 * deterministic fake server: dispatch, detail GET, terminal facts,
 * idempotency propagation, envelope parsing, redaction, rate limits, and
 * response loss. The fake is wired through the same `fetchFn` seam the
 * production client uses — no test shortcut exists.
 */
import { describe, expect, test } from "bun:test";
import { StateError } from "./errors.ts";
import {
	DispatchUncertainError,
	type FetchLike,
	readTerminalFacts,
	redactSecret,
	WarrenAuthError,
	WarrenClient,
	WarrenEnvelopeError,
	WarrenRateLimitError,
	WarrenRejectedError,
	WarrenUnreachableError,
} from "./warren-client.ts";
import { FakeWarrenServer } from "./warren-fake.ts";

const TOKEN = "sekrit-warren-token";

function makeClient(
	fake: FakeWarrenServer,
	sleeps: number[] = [],
	maxReadRetries?: number,
): WarrenClient {
	return new WarrenClient({
		baseUrl: "http://warren.local/",
		token: TOKEN,
		fetchFn: fake.fetch as FetchLike,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		maxReadRetries,
	});
}

function makeFake(): FakeWarrenServer {
	return new FakeWarrenServer({ token: TOKEN });
}

const DISPATCH = {
	project: "openclaw-fork",
	agent: "pi",
	prompt: "Resolve issue openclaw#12 (explicit approved issue work)",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	maxCostUsd: 5,
	idempotencyKey: "campaign-abc-issue-12",
};

describe("WarrenClient.verifyCredential", () => {
	test("verifies the credential and reports the identity", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		expect(await client.verifyCredential()).toEqual({ identity: "operator" });
		expect(fake.recordedRequests()).toHaveLength(1);
	});

	test("a rejected credential raises WarrenAuthError without leaking the token", async () => {
		const badTokenClient = new WarrenClient({
			baseUrl: "http://warren.local",
			token: "wrong-token",
			fetchFn: makeFake().fetch as FetchLike,
			sleep: async () => {},
		});
		let err: unknown;
		try {
			await badTokenClient.verifyCredential();
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WarrenAuthError);
		expect(JSON.stringify(err)).not.toContain("wrong-token");
		expect(String(err)).not.toContain("Bearer");
	});
});

describe("WarrenClient.dispatchRun", () => {
	test("dispatches an explicit issue-derived run and parses the {run} envelope", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const run = await client.dispatchRun(DISPATCH);
		expect(run.id).toBe("seq-1");
		expect(run.state).toBe("queued");
		const row = fake.getRunRow(run.id);
		expect(row?.agentName).toBe("pi");
		expect(row?.projectId).toBe("openclaw-fork");
		expect(row?.prompt).toContain("openclaw#12");
		expect(row?.provider).toBe("anthropic");
		expect(row?.model).toBe("claude-sonnet-4-5");
		expect(row?.maxCostUsd).toBe(5);
	});

	test("propagates the exact stable Idempotency-Key header and body fields", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		await client.dispatchRun(DISPATCH);
		const req = fake.recordedRequests()[0];
		expect(req?.method).toBe("POST");
		expect(req?.path).toBe("/runs");
		expect(req?.headers["idempotency-key"]).toBe("campaign-abc-issue-12");
		expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(req?.headers["content-type"]).toBe("application/json");
		expect(req?.body).toEqual({
			agent: "pi",
			project: "openclaw-fork",
			prompt: DISPATCH.prompt,
			providerOverride: "anthropic",
			modelOverride: "claude-sonnet-4-5",
			maxCostUsd: 5,
		});
	});

	test("a duplicate delivery with the same key returns the same run", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const first = await client.dispatchRun(DISPATCH);
		const second = await client.dispatchRun(DISPATCH);
		expect(second.id).toBe(first.id);
		expect(fake.createdRunCount()).toBe(1);
		expect(fake.recordedRequests()).toHaveLength(2);
	});

	test("a rejected dispatch raises WarrenRejectedError with the warren error code", async () => {
		const fake = makeFake();
		fake.respondOnceWith(
			new Response(JSON.stringify({ error: { code: "validation_error", message: "no agent" } }), {
				status: 400,
			}),
		);
		const client = makeClient(fake);
		let err: unknown;
		try {
			await client.dispatchRun(DISPATCH);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WarrenRejectedError);
		expect((err as WarrenRejectedError).status).toBe(400);
		expect((err as WarrenRejectedError).warrenCode).toBe("validation_error");
		// One request only: the client never retries a dispatch POST.
		expect(fake.recordedRequests()).toHaveLength(1);
	});

	test("a 429 dispatch is unambiguous rate limiting, never retried here", async () => {
		const fake = makeFake();
		fake.respondOnceWith(new Response("{}", { status: 429, headers: { "Retry-After": "7" } }));
		const client = makeClient(fake);
		let err: unknown;
		try {
			await client.dispatchRun(DISPATCH);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WarrenRateLimitError);
		expect((err as WarrenRateLimitError).retryAfterMs).toBe(7000);
		expect(fake.recordedRequests()).toHaveLength(1);
		expect(fake.createdRunCount()).toBe(0);
	});

	test("an empty idempotency key is a validation failure before any I/O", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		await expect(client.dispatchRun({ ...DISPATCH, idempotencyKey: "  " })).rejects.toThrow(
			/idempotencyKey/,
		);
		expect(fake.recordedRequests()).toHaveLength(0);
	});
});

describe("WarrenClient accepted-response loss (fail closed)", () => {
	test("a lost response after acceptance is dispatch_uncertain and not retried", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		fake.dropNextResponses(1);
		let err: unknown;
		try {
			await client.dispatchRun(DISPATCH);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(DispatchUncertainError);
		// The run WAS accepted server-side — the client just cannot know.
		expect(fake.createdRunCount()).toBe(1);
		expect(fake.recordedRequests()).toHaveLength(1);
		expect(JSON.stringify(err)).not.toContain(TOKEN);
	});

	test("re-dispatching the same key after response loss does not duplicate work", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		fake.dropNextResponses(1);
		await expect(client.dispatchRun(DISPATCH)).rejects.toBeInstanceOf(DispatchUncertainError);
		const run = await client.dispatchRun(DISPATCH);
		expect(fake.createdRunCount()).toBe(1);
		expect(fake.getRunRow(run.id)?.id).toBe(run.id);
	});

	test("a 5xx dispatch is dispatch_uncertain", async () => {
		const fake = makeFake();
		fake.respondOnceWith(new Response("boom", { status: 503 }));
		const client = makeClient(fake);
		await expect(client.dispatchRun(DISPATCH)).rejects.toBeInstanceOf(DispatchUncertainError);
		expect(fake.recordedRequests()).toHaveLength(1);
	});

	test("after a restart wipes idempotency, a lost response plus repeat duplicates — the fail-closed rationale", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		fake.dropNextResponses(1);
		await expect(client.dispatchRun(DISPATCH)).rejects.toBeInstanceOf(DispatchUncertainError);
		fake.restart();
		const run = await client.dispatchRun(DISPATCH);
		// The in-memory idempotency store died with the restart, so warren
		// cannot dedupe: exactly why this client never auto-retries.
		expect(fake.createdRunCount()).toBe(2);
		expect(fake.getRunRow(run.id)?.id).toBe(run.id);
	});
});

describe("WarrenClient.getRun", () => {
	test("fetches run detail through the {run} envelope", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const { id } = await client.dispatchRun(DISPATCH);
		const run = await client.getRun(id);
		expect(run.id).toBe(id);
		expect(run.state).toBe("queued");
	});

	test("a considered 404 is a rejection, not a retry", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		let err: unknown;
		try {
			await client.getRun("nope");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WarrenRejectedError);
		expect((err as WarrenRejectedError).status).toBe(404);
		expect(fake.recordedRequests()).toHaveLength(1);
	});

	test("rate-limited reads honor Retry-After and then succeed", async () => {
		const fake = makeFake();
		const sleeps: number[] = [];
		const client = makeClient(fake, sleeps);
		const { id } = await client.dispatchRun(DISPATCH);
		fake.rateLimitReads(2, 1);
		const run = await client.getRun(id);
		expect(run.id).toBe(id);
		expect(sleeps).toEqual([1000, 1000]);
	});

	test("reads fall back to bounded exponential backoff without Retry-After", async () => {
		const fake = makeFake();
		const sleeps: number[] = [];
		const { id } = await client0Dispatch(fake);
		fake.rateLimitReads(1, null);
		const run = await makeClient(fake, sleeps).getRun(id);
		expect(run.id).toBe(id);
		expect(sleeps).toEqual([100]);
	});

	test("reads give up after the bounded retry budget", async () => {
		const fake = makeFake();
		const { id } = await client0Dispatch(fake);
		fake.rateLimitReads(99, null);
		const sleeps: number[] = [];
		let err: unknown;
		try {
			await makeClient(fake, sleeps, 2).getRun(id);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WarrenRateLimitError);
		expect(fake.recordedRequests().filter((r) => r.method === "GET")).toHaveLength(3);
		expect(sleeps).toEqual([100, 200]);
	});

	test("repeated network loss on a read exhausts into WarrenUnreachableError", async () => {
		const fake = makeFake();
		const { id } = await client0Dispatch(fake);
		fake.dropNextResponses(99);
		await expect(makeClient(fake, [], 1).getRun(id)).rejects.toBeInstanceOf(WarrenUnreachableError);
	});
});

/** Dispatch once with the shared fixture, returning the run id. */
async function client0Dispatch(fake: FakeWarrenServer): Promise<{ id: string }> {
	const client = makeClient(fake);
	const run = await client.dispatchRun(DISPATCH);
	return { id: run.id };
}

describe("terminal-state facts", () => {
	test("readTerminalFacts refuses a nonterminal run", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const { id } = await client.dispatchRun(DISPATCH);
		const run = await client.getRun(id);
		expect(() => readTerminalFacts(run)).toThrow(StateError);
	});

	test("readTerminalFacts exposes branch/ref/outcome/cost on a terminal run", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const { id } = await client.dispatchRun(DISPATCH);
		fake.setRunState(id, {
			state: "succeeded",
			ref: "refs/heads/main",
			targetBranch: "warren/run/seq-1",
			branch: "warren/run/seq-1",
			costUsd: 1.25,
		});
		const facts = readTerminalFacts(await client.getRun(id));
		expect(facts).toEqual({
			runId: id,
			state: "succeeded",
			failureReason: null,
			ref: "refs/heads/main",
			targetBranch: "warren/run/seq-1",
			branch: "warren/run/seq-1",
			costUsd: 1.25,
		});
	});

	test("a failed terminal run carries its failure reason", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const { id } = await client.dispatchRun(DISPATCH);
		fake.setRunState(id, { state: "failed", failureReason: "provider_error" });
		const facts = readTerminalFacts(await client.getRun(id));
		expect(facts.state).toBe("failed");
		expect(facts.failureReason).toBe("provider_error");
	});
});

describe("envelope parsing", () => {
	test("a non-JSON body raises WarrenEnvelopeError", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const { id } = await client.dispatchRun(DISPATCH);
		fake.respondOnceWith(new Response("<html>gateway</html>", { status: 200 }));
		await expect(client.getRun(id)).rejects.toBeInstanceOf(WarrenEnvelopeError);
	});

	test("a 2xx body without the run member raises WarrenEnvelopeError", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const { id } = await client.dispatchRun(DISPATCH);
		fake.respondOnceWith(new Response(JSON.stringify({ runs: [] }), { status: 200 }));
		await expect(client.getRun(id)).rejects.toThrow(/not a \{run\} envelope/);
	});

	test("a run object without an id raises WarrenEnvelopeError", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const { id } = await client.dispatchRun(DISPATCH);
		fake.respondOnceWith(
			new Response(JSON.stringify({ run: { state: "queued" } }), { status: 200 }),
		);
		await expect(client.getRun(id)).rejects.toThrow(/missing a string 'id'/);
	});

	test("a run object without a state raises WarrenEnvelopeError", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		const { id } = await client.dispatchRun(DISPATCH);
		fake.respondOnceWith(new Response(JSON.stringify({ run: { id } }), { status: 200 }));
		await expect(client.getRun(id)).rejects.toThrow(/missing a string 'state'/);
	});
});

describe("redaction", () => {
	test("redactSecret strips every occurrence of a secret", () => {
		expect(redactSecret(`Bearer ${TOKEN} leaked`, TOKEN)).toBe("Bearer [redacted] leaked");
		expect(redactSecret("clean text", TOKEN)).toBe("clean text");
		expect(redactSecret("x", "")).toBe("x");
	});

	test("no error surfaced by the client ever embeds the token", async () => {
		const fake = makeFake();
		const client = makeClient(fake);
		fake.dropNextResponses(1);
		const failures: unknown[] = [];
		await client.dispatchRun(DISPATCH).catch((e) => failures.push(e));
		fake.rateLimitReads(99, null);
		await client.getRun("seq-1").catch((e) => failures.push(e));
		fake.respondOnceWith(new Response("{}", { status: 403 }));
		await client.verifyCredential().catch((e) => failures.push(e));
		for (const failure of failures) {
			const rendered = `${JSON.stringify(failure)} ${String(failure)}`;
			expect(rendered).not.toContain(TOKEN);
			expect(rendered).not.toContain("Bearer ");
		}
		expect(failures).toHaveLength(3);
	});
});
