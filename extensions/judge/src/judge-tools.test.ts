import { describe, expect, test } from "bun:test";
import { createClient } from "./client.ts";
import { FakeWarren } from "./fake-warren.ts";
import { JudgeToolError, createJudgeTools } from "./judge-tools.ts";

function withFakeWarren(fn: (fake: FakeWarren) => Promise<void>): () => Promise<void> {
	return async () => {
		const fake = new FakeWarren();
		fake.start();
		try {
			await fn(fake);
		} finally {
			fake.stop();
		}
	};
}

function makeClient(fake: FakeWarren) {
	return createClient({ baseUrl: fake.baseUrl, token: "tok" });
}

function seedEvents(fake: FakeWarren, runId: string, count: number): void {
	for (let seq = 1; seq <= count; seq++) {
		fake.addEvent(runId, {
			id: seq,
			seq,
			ts: `2026-08-15T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
			kind: "stdout",
			stream: "agent",
			payload: { text: `event ${seq}` },
		});
	}
}

describe("get_run_facts tool", () => {
	test(
		"returns the run's ground truth as JSON text",
		withFakeWarren(async (fake) => {
			fake.addRun({
				id: "run-1",
				state: "succeeded",
				startedAt: "2026-08-15T00:00:00.000Z",
				detail: { costUsd: 0.42, prState: "merged" },
			});
			const { tools } = createJudgeTools({
				client: makeClient(fake),
				runId: "run-1",
				eventsPageSize: 50,
				maxPages: 5,
			});
			const facts = tools.find((t) => t.name === "get_run_facts");
			expect(facts).toBeDefined();
			const result = await facts?.execute("call-1", {});
			expect(result?.terminate).toBeUndefined();
			const parsed = JSON.parse(result?.content[0]?.text ?? "{}") as Record<string, unknown>;
			expect(parsed.id).toBe("run-1");
			expect(parsed.state).toBe("succeeded");
			expect(parsed.costUsd).toBe(0.42);
			expect(parsed.prState).toBe("merged");
		}),
	);
});

describe("page_events tool", () => {
	test(
		"cursors events by exclusive since and reports the next cursor",
		withFakeWarren(async (fake) => {
			fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T00:00:00.000Z" });
			seedEvents(fake, "run-1", 10);
			const { tools, state } = createJudgeTools({
				client: makeClient(fake),
				runId: "run-1",
				eventsPageSize: 4,
				maxPages: 5,
			});
			const page = tools.find((t) => t.name === "page_events");
			const first = JSON.parse(
				(await page?.execute("c1", { since: 0 }))?.content[0]?.text ?? "{}",
			) as { events: { seq: number }[]; nextSince: number; hasMore: boolean };
			expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
			expect(first.nextSince).toBe(4);
			expect(first.hasMore).toBe(true);
			expect(state.pagesRead).toBe(1);

			const second = JSON.parse(
				(await page?.execute("c2", { since: first.nextSince, limit: 3 }))?.content[0]?.text ??
					"{}",
			) as { events: { seq: number }[]; nextSince: number };
			expect(second.events.map((e) => e.seq)).toEqual([5, 6, 7]);
			expect(second.nextSince).toBe(7);
			expect(state.pagesRead).toBe(2);
		}),
	);

	test(
		"enforces the hard page cap and degrades instead of unbounded spend",
		withFakeWarren(async (fake) => {
			fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T00:00:00.000Z" });
			seedEvents(fake, "run-1", 100);
			const { tools, state } = createJudgeTools({
				client: makeClient(fake),
				runId: "run-1",
				eventsPageSize: 10,
				maxPages: 2,
			});
			const page = tools.find((t) => t.name === "page_events");
			await page?.execute("c1", { since: 0 });
			const second = JSON.parse(
				(await page?.execute("c2", { since: 10 }))?.content[0]?.text ?? "{}",
			) as { pageCapHit: boolean };
			expect(second.pageCapHit).toBe(true);

			const capped = JSON.parse(
				(await page?.execute("c3", { since: 20 }))?.content[0]?.text ?? "{}",
			) as { error?: string; events?: unknown[] };
			expect(capped.error).toBe("page_cap_reached");
			expect(capped.events).toBeUndefined();
			expect(state.pageCapHit).toBe(true);
			expect(state.pagesRead).toBe(2);
		}),
	);

	test(
		"stops serving transcript once accrued cost reaches the per-judgment cap",
		withFakeWarren(async (fake) => {
			fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T00:00:00.000Z" });
			seedEvents(fake, "run-1", 20);
			let accrued = 0.1;
			const { tools, state } = createJudgeTools({
				client: makeClient(fake),
				runId: "run-1",
				eventsPageSize: 5,
				maxPages: 10,
				maxCostUsd: 0.25,
				getAccruedCostUsd: () => accrued,
			});
			const page = tools.find((t) => t.name === "page_events");
			const served = JSON.parse(
				(await page?.execute("c1", { since: 0 }))?.content[0]?.text ?? "{}",
			) as { events: unknown[] };
			expect(served.events).toHaveLength(5);
			expect(state.costCapHit).toBe(false);

			accrued = 0.25;
			const refused = JSON.parse(
				(await page?.execute("c2", { since: 5 }))?.content[0]?.text ?? "{}",
			) as { error?: string; events?: unknown[]; message?: string };
			expect(refused.error).toBe("cost_cap_reached");
			expect(refused.events).toBeUndefined();
			expect(refused.message).toContain("report_verdict");
			expect(state.costCapHit).toBe(true);
			// A refused page never counts against the page budget.
			expect(state.pagesRead).toBe(1);
		}),
	);

	test(
		"serves pages without a cost gate when no cap is configured",
		withFakeWarren(async (fake) => {
			fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T00:00:00.000Z" });
			seedEvents(fake, "run-1", 5);
			const { tools, state } = createJudgeTools({
				client: makeClient(fake),
				runId: "run-1",
				eventsPageSize: 5,
				maxPages: 10,
				getAccruedCostUsd: () => 999,
			});
			const page = tools.find((t) => t.name === "page_events");
			const served = JSON.parse(
				(await page?.execute("c1", { since: 0 }))?.content[0]?.text ?? "{}",
			) as { events: unknown[] };
			expect(served.events).toHaveLength(5);
			expect(state.costCapHit).toBe(false);
		}),
	);

	test("rejects a malformed since cursor without touching warren", async () => {
		const { tools } = createJudgeTools({
			client: createClient({ baseUrl: "http://127.0.0.1:1", token: "tok" }),
			runId: "run-1",
			eventsPageSize: 10,
			maxPages: 5,
		});
		const page = tools.find((t) => t.name === "page_events");
		await expect(page?.execute("c1", { since: -1 })).rejects.toBeInstanceOf(JudgeToolError);
		await expect(page?.execute("c2", "nope")).rejects.toBeInstanceOf(JudgeToolError);
	});
});

describe("report_verdict tool", () => {
	function validArgs(runId: string) {
		return {
			runId,
			assignments: [
				{
					class: "spin_loop",
					confidence: "high",
					evidence: [{ fromSeq: 3, toSeq: 9 }],
				},
			],
		};
	}

	test(
		"captures a validated verdict and terminates the loop",
		withFakeWarren(async (fake) => {
			const { tools, state } = createJudgeTools({
				client: makeClient(fake),
				runId: "run-1",
				eventsPageSize: 10,
				maxPages: 5,
			});
			const report = tools.find((t) => t.name === "report_verdict");
			const result = await report?.execute("c1", validArgs("run-1"));
			expect(result?.terminate).toBe(true);
			expect(state.reportedVerdict?.assignments[0]?.class).toBe("spin_loop");
		}),
	);

	test(
		"rejects a malformed verdict at the tool layer and leaves state uncaptured",
		withFakeWarren(async (fake) => {
			const { tools, state } = createJudgeTools({
				client: makeClient(fake),
				runId: "run-1",
				eventsPageSize: 10,
				maxPages: 5,
			});
			const report = tools.find((t) => t.name === "report_verdict");
			const malformed = {
				runId: "run-1",
				assignments: [{ class: "clean", confidence: "high", evidence: [{ fromSeq: 1, toSeq: 2 }] }],
			};
			await expect(report?.execute("c1", malformed)).rejects.toBeInstanceOf(JudgeToolError);
			expect(state.reportedVerdict).toBeNull();
		}),
	);

	test(
		"rejects a verdict for a different run than the one being judged",
		withFakeWarren(async (fake) => {
			const { tools, state } = createJudgeTools({
				client: makeClient(fake),
				runId: "run-1",
				eventsPageSize: 10,
				maxPages: 5,
			});
			const report = tools.find((t) => t.name === "report_verdict");
			await expect(report?.execute("c1", validArgs("run-OTHER"))).rejects.toBeInstanceOf(
				JudgeToolError,
			);
			expect(state.reportedVerdict).toBeNull();
		}),
	);

	test(
		"exposes prompt guidelines that make report_verdict the mandatory final action",
		withFakeWarren(async (fake) => {
			const { tools } = createJudgeTools({
				client: makeClient(fake),
				runId: "run-1",
				eventsPageSize: 10,
				maxPages: 5,
			});
			const report = tools.find((t) => t.name === "report_verdict");
			const guidelines = (report?.promptGuidelines ?? []).join("\n");
			expect(guidelines).toContain("MANDATORY final action");
		}),
	);
});
