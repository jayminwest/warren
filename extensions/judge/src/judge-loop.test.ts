import { describe, expect, test } from "bun:test";
import { createClient } from "./client.ts";
import { FakeWarren } from "./fake-warren.ts";
import {
	DEFAULT_EVENTS_PAGE_SIZE,
	DEFAULT_MAX_PAGES,
	type JudgeSession,
	type JudgeSessionFactory,
	judgeRun,
} from "./judge-loop.ts";
import type { JudgeToolSpec } from "./judge-tools.ts";

const RUBRIC_VERSION = "sha256:" + "ab".repeat(32);
const JUDGED_AT = new Date("2026-08-15T17:00:00.000Z");

interface StubBehavior {
	/**
	 * Per-attempt behavior: report a verdict, end in plain text, throw, or
	 * end the turn the way a provider failure does, with the text on the
	 * session state and nothing thrown.
	 */
	kind: "verdict" | "plain_text" | "throw" | "provider_error";
	args?: unknown;
	message?: string;
}

/**
 * A stubbed session that plays the model: on prompt it drives the same
 * tool exec surface the pi loop would, per the scripted behavior.
 */
function makeStubFactory(
	behaviors: StubBehavior[],
	costPerAttempt: number,
): { factory: JudgeSessionFactory; calls: { systemPrompt: string; tools: string[] }[] } {
	const calls: { systemPrompt: string; tools: string[] }[] = [];
	const factory: JudgeSessionFactory = async ({ systemPrompt, tools }) => {
		calls.push({ systemPrompt, tools: tools.map((t) => t.name) });
		const behavior = behaviors[Math.min(calls.length - 1, behaviors.length - 1)] ?? {
			kind: "plain_text",
		};
		const session: JudgeSession = {
			prompt: async () => {},
			waitForIdle: async () => {
				const report = tools.find((t) => t.name === "report_verdict");
				if (behavior.kind === "throw") {
					throw new Error(behavior.message ?? "provider exploded");
				}
				if (behavior.kind === "verdict") {
					await report?.execute("call-1", behavior.args);
				}
			},
			getSessionStats: () => ({
				tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
				costUsd: costPerAttempt,
			}),
			getLastError: () =>
				behavior.kind === "provider_error"
					? (behavior.message ?? "provider returned an error")
					: null,
			dispose: () => {},
		};
		return session;
	};
	return { factory, calls };
}

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

function verdictArgs(runId: string) {
	return {
		runId,
		assignments: [
			{
				class: "spin_loop",
				confidence: "medium",
				evidence: [{ fromSeq: 1, toSeq: 3 }],
				note: "re-ran the same test",
			},
		],
	};
}

function judgeOpts(fake: FakeWarren, factory: JudgeSessionFactory) {
	fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T00:00:00.000Z" });
	for (let seq = 1; seq <= 3; seq++) {
		fake.addEvent("run-1", {
			id: seq,
			seq,
			ts: JUDGED_AT.toISOString(),
			kind: "stdout",
			stream: null,
			payload: {},
		});
	}
	return {
		client: createClient({ baseUrl: fake.baseUrl, token: "tok" }),
		runId: "run-1",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		rubricVersion: RUBRIC_VERSION,
		sessionFactory: factory,
		now: () => JUDGED_AT,
	};
}

describe("judgeRun", () => {
	test(
		"returns a wire-validated verdict when the session reports one",
		withFakeWarren(async (fake) => {
			const { factory, calls } = makeStubFactory(
				[{ kind: "verdict", args: verdictArgs("run-1") }],
				0.0031,
			);
			const outcome = await judgeRun(judgeOpts(fake, factory));
			expect(outcome.kind).toBe("verdict");
			if (outcome.kind !== "verdict") throw new Error("expected verdict");
			expect(outcome.verdict.runId).toBe("run-1");
			expect(outcome.verdict.assignments[0]?.class).toBe("spin_loop");
			expect(outcome.verdict.provenance.provider).toBe("anthropic");
			expect(outcome.verdict.provenance.model).toBe("claude-haiku-4-5");
			expect(outcome.verdict.provenance.rubricVersion).toBe(RUBRIC_VERSION);
			expect(outcome.verdict.provenance.judgedAt).toBe(JUDGED_AT.toISOString());
			expect(outcome.verdict.provenance.costUsd).toBe(0.0031);
			expect(outcome.verdict.provenance.pagesRead).toBe(0);
			expect(outcome.verdict.provenance.pageCapHit).toBe(false);
			expect(outcome.stats.attempts).toBe(1);
			expect(calls).toHaveLength(1);
		}),
	);

	test(
		"registers exactly the three judge tools with the rubric system prompt",
		withFakeWarren(async (fake) => {
			const { factory, calls } = makeStubFactory(
				[{ kind: "verdict", args: verdictArgs("run-1") }],
				0,
			);
			await judgeRun(judgeOpts(fake, factory));
			expect(calls[0]?.tools).toEqual(["get_run_facts", "page_events", "report_verdict"]);
			expect(calls[0]?.systemPrompt).toContain("rubric-v1");
		}),
	);

	test(
		"retries a plain-text judgment within the bounded budget, then succeeds",
		withFakeWarren(async (fake) => {
			const { factory } = makeStubFactory(
				[{ kind: "plain_text" }, { kind: "verdict", args: verdictArgs("run-1") }],
				0.001,
			);
			const outcome = await judgeRun(judgeOpts(fake, factory));
			expect(outcome.kind).toBe("verdict");
			expect(outcome.stats.attempts).toBe(2);
			expect(outcome.stats.costUsd).toBeCloseTo(0.002, 6);
			expect(outcome.stats.tokens.total).toBe(300);
		}),
	);

	test(
		"exhausts the retry budget on missing verdicts and marks the run unjudged",
		withFakeWarren(async (fake) => {
			const { factory } = makeStubFactory(
				[{ kind: "plain_text" }, { kind: "plain_text" }, { kind: "plain_text" }],
				0.001,
			);
			const outcome = await judgeRun({ ...judgeOpts(fake, factory), maxRetries: 2 });
			expect(outcome.kind).toBe("unjudged");
			if (outcome.kind !== "unjudged") throw new Error("expected unjudged");
			expect(outcome.reason).toBe("malformed_verdict");
			expect(outcome.detail).toContain("exhausted 3 attempt(s)");
			expect(outcome.stats.attempts).toBe(3);
		}),
	);

	test(
		"retries a malformed report_verdict call too — tool throws, model ends",
		withFakeWarren(async (fake) => {
			const malformed = {
				runId: "run-1",
				assignments: [
					{ class: "spin_loop", confidence: "high", evidence: [] },
				],
			};
			const { factory } = makeStubFactory(
				[{ kind: "verdict", args: malformed }, { kind: "verdict", args: verdictArgs("run-1") }],
				0.001,
			);
			// Attempt 1: execute throws, our stub continues and reports nothing.
			const wrapping: JudgeSessionFactory = async (opts) => {
				const session = await factory(opts);
				const report = opts.tools.find((t: JudgeToolSpec) => t.name === "report_verdict");
				return {
					...session,
					waitForIdle: async () => {
						if (behaviorIndex === 0) {
							await report
								?.execute("c1", malformed)
								.catch(() => {});
						} else {
							await report?.execute("c1", verdictArgs("run-1"));
						}
						behaviorIndex += 1;
					},
				};
			};
			let behaviorIndex = 0;
			const outcome = await judgeRun(judgeOpts(fake, wrapping));
			expect(outcome.kind).toBe("verdict");
			expect(outcome.stats.attempts).toBe(2);
		}),
	);

	test(
		"marks judge_error when the session layer throws on every attempt",
		withFakeWarren(async (fake) => {
			const { factory } = makeStubFactory(
				[{ kind: "throw", message: "provider exploded" }],
				0.005,
			);
			const outcome = await judgeRun({ ...judgeOpts(fake, factory), maxRetries: 1 });
			expect(outcome.kind).toBe("unjudged");
			if (outcome.kind !== "unjudged") throw new Error("expected unjudged");
			expect(outcome.reason).toBe("judge_error");
			expect(outcome.detail).toContain("provider exploded");
		}),
	);

	test(
		"ends on the provider's error instead of spending the retry budget",
		withFakeWarren(async (fake) => {
			const { factory, calls } = makeStubFactory(
				[{ kind: "provider_error", message: "401 invalid x-api-key" }],
				0.001,
			);
			const outcome = await judgeRun({ ...judgeOpts(fake, factory), maxRetries: 2 });
			expect(outcome.kind).toBe("unjudged");
			if (outcome.kind !== "unjudged") throw new Error("expected unjudged");
			expect(outcome.reason).toBe("judge_error");
			expect(outcome.detail).toContain("401 invalid x-api-key");
			expect(outcome.stats.attempts).toBe(1);
			expect(calls).toHaveLength(1);
		}),
	);

	test(
		"stops early with budget_exceeded when accrued cost reaches the per-judgment cap",
		withFakeWarren(async (fake) => {
			const { factory } = makeStubFactory(
				[{ kind: "plain_text" }, { kind: "plain_text" }, { kind: "plain_text" }],
				0.04,
			);
			const outcome = await judgeRun({
				...judgeOpts(fake, factory),
				maxRetries: 5,
				maxCostUsdPerJudgment: 0.05,
			});
			expect(outcome.kind).toBe("unjudged");
			if (outcome.kind !== "unjudged") throw new Error("expected unjudged");
			expect(outcome.reason).toBe("budget_exceeded");
			expect(outcome.stats.attempts).toBe(2);
		}),
	);

	test(
		"records pages read and the cap flag in provenance when the tail is truncated",
		withFakeWarren(async (fake) => {
			fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T00:00:00.000Z" });
			for (let seq = 1; seq <= 500; seq++) {
				fake.addEvent("run-1", {
					id: seq,
					seq,
					ts: JUDGED_AT.toISOString(),
					kind: "stdout",
					stream: null,
					payload: {},
				});
			}
			// The model pages three times (page size 2, cap 3), then reports
			// with evidence only from what it saw.
			const factory: JudgeSessionFactory = async ({ tools }) => {
				const page = tools.find((t) => t.name === "page_events");
				const report = tools.find((t) => t.name === "report_verdict");
				return {
					prompt: async () => {},
					waitForIdle: async () => {
						await page?.execute("p1", { since: 0, limit: 2 });
						await page?.execute("p2", { since: 2, limit: 2 });
						await page?.execute("p3", { since: 4, limit: 2 });
						await page?.execute("p4", { since: 6, limit: 2 });
						await report?.execute("r1", {
							runId: "run-1",
							assignments: [
								{
									class: "clean",
									confidence: "low",
									evidence: [],
								},
							],
						});
					},
					getSessionStats: () => ({
						tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
						costUsd: 0.001,
					}),
					getLastError: () => null,
					dispose: () => {},
				};
			};
			const outcome = await judgeRun({
				...judgeOpts(fake, factory),
				maxPages: 3,
				eventsPageSize: 2,
			});
			expect(outcome.kind).toBe("verdict");
			if (outcome.kind !== "verdict") throw new Error("expected verdict");
			expect(outcome.verdict.provenance.pagesRead).toBe(3);
			expect(outcome.verdict.provenance.pageCapHit).toBe(true);
			expect(outcome.stats.pagesRead).toBe(3);
		}),
	);

	test(
		"gates page_events on live session cost mid-attempt but still lands the verdict",
		withFakeWarren(async (fake) => {
			fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T00:00:00.000Z" });
			for (let seq = 1; seq <= 20; seq++) {
				fake.addEvent("run-1", {
					id: seq,
					seq,
					ts: JUDGED_AT.toISOString(),
					kind: "stdout",
					stream: null,
					payload: {},
				});
			}
			const pageResults: { error?: string }[] = [];
			// The session's cost grows past the cap after the first page, the
			// way a real attempt accrues spend turn by turn.
			let sessionCost = 0.1;
			const factory: JudgeSessionFactory = async ({ tools }) => {
				const page = tools.find((t) => t.name === "page_events");
				const report = tools.find((t) => t.name === "report_verdict");
				return {
					prompt: async () => {},
					waitForIdle: async () => {
						for (const call of ["p1", "p2"]) {
							const res = await page?.execute(call, { since: 0, limit: 5 });
							pageResults.push(
								JSON.parse(res?.content[0]?.text ?? "{}") as { error?: string },
							);
							sessionCost = 0.3;
						}
						await report?.execute("r1", verdictArgs("run-1"));
					},
					getSessionStats: () => ({
						tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
						costUsd: sessionCost,
					}),
					getLastError: () => null,
					dispose: () => {},
				};
			};
			const outcome = await judgeRun({
				...judgeOpts(fake, factory),
				maxCostUsdPerJudgment: 0.25,
			});
			expect(pageResults[0]?.error).toBeUndefined();
			expect(pageResults[1]?.error).toBe("cost_cap_reached");
			// The capped attempt still resolves to a verdict, not a marker.
			expect(outcome.kind).toBe("verdict");
			if (outcome.kind !== "verdict") throw new Error("expected verdict");
			expect(outcome.verdict.provenance.costUsd).toBeCloseTo(0.3, 6);
		}),
	);

	test(
		"the mid-attempt cost gate counts prior attempts' spend, not just the live session",
		withFakeWarren(async (fake) => {
			fake.addRun({ id: "run-1", state: "failed", startedAt: "2026-08-15T00:00:00.000Z" });
			fake.addEvent("run-1", {
				id: 1,
				seq: 1,
				ts: JUDGED_AT.toISOString(),
				kind: "stdout",
				stream: null,
				payload: {},
			});
			const pageErrors: (string | undefined)[] = [];
			let attempt = 0;
			const factory: JudgeSessionFactory = async ({ tools }) => {
				attempt += 1;
				const isRetry = attempt === 2;
				const page = tools.find((t) => t.name === "page_events");
				const report = tools.find((t) => t.name === "report_verdict");
				return {
					prompt: async () => {},
					waitForIdle: async () => {
						const res = await page?.execute("p1", { since: 0, limit: 1 });
						pageErrors.push(
							(JSON.parse(res?.content[0]?.text ?? "{}") as { error?: string }).error,
						);
						// Attempt 1 ends in plain text; attempt 2 reports.
						if (isRetry) await report?.execute("r1", verdictArgs("run-1"));
					},
					getSessionStats: () => ({
						tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
						costUsd: 0.15,
					}),
					getLastError: () => null,
					dispose: () => {},
				};
			};
			const outcome = await judgeRun({
				...judgeOpts(fake, factory),
				// Cap 0.28: attempt 1 alone (0.15) stays under, so the loop
				// retries; attempt 2's gate sees 0.15 + 0.15 and refuses.
				maxCostUsdPerJudgment: 0.28,
			});
			expect(pageErrors[0]).toBeUndefined();
			expect(pageErrors[1]).toBe("cost_cap_reached");
			expect(outcome.kind).toBe("verdict");
		}),
	);

	test("default knobs document the bounded shape", () => {
		expect(DEFAULT_MAX_PAGES).toBe(40);
		expect(DEFAULT_EVENTS_PAGE_SIZE).toBe(200);
	});
});
