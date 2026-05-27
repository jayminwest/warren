/**
 * Shared fixtures for `src/runs/stream/*.test.ts`. Split out of the
 * monolithic `src/runs/stream.test.ts` as part of warren-041e /
 * pl-9088 step 5; the helpers are deliberately small and have no
 * Bun-test imports so a `*.test.ts` can be the consumer.
 */

import type { RunEvent } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import type { Repos } from "../../db/repos/index.ts";

export function makeBurrowClient(): BurrowClient {
	const fetchImpl = (async () =>
		new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
	return new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: fetchImpl,
	});
}

/**
 * One-worker pool wired to a stub burrow client (warren-c0c9). Upserts a
 * `local` worker row so `pool.clientFor` resolves cleanly; tests that exercise
 * a non-test source (i.e. don't pass `source: ...`) also seed a `burrows` row.
 */
export async function makePool(
	repos: Repos,
	client?: BurrowClient,
	workerName = "local",
): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: workerName, url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	pool.register(workerName, client ?? makeBurrowClient());
	return pool;
}

export function evt(burrowRunId: string, seq: number, overrides: Partial<RunEvent> = {}): RunEvent {
	return {
		id: 0,
		burrowId: "bur_x",
		runId: burrowRunId,
		seq,
		kind: "text",
		stream: "stdout",
		payload: { seq },
		ts: new Date(2026, 4, 8, 12, 0, seq),
		...overrides,
	};
}

export async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
	for (const i of items) yield i;
}

export function source(events: RunEvent[]): (signal: AbortSignal) => AsyncIterable<RunEvent> {
	return () => asyncIter(events);
}

/**
 * Build a pi-shaped `agent_end` envelope as it lands after burrow's pi
 * parser (kind="state_change", stream="system", payload.type="agent_end").
 * Mirrors burrow `src/runtime/parsers/pi.ts:86-98` (warren-36c0). The
 * synthetic `{kind:"agent_end"}` shape never appears in production.
 */
export function piAgentEnd(burrowRunId: string, seq: number): RunEvent {
	return evt(burrowRunId, seq, {
		kind: "state_change",
		stream: "system",
		payload: { type: "agent_end", messages: [] },
	});
}

/**
 * Pi v0.74 `turn_end` envelope carrying `message.usage.{input,output,
 * cacheRead,cacheWrite,cost.total}` — see burrow's
 * `src/runtime/parsers/__golden__/pi-v0.74.0-anthropic-*.jsonl`. The
 * bridge accumulates these as events flow through and persists the
 * run-level totals at `agent_end`, no PiStatsClient required.
 */
export function piTurnEnd(
	burrowRunId: string,
	seq: number,
	usage: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		costTotal: number;
	},
): RunEvent {
	return evt(burrowRunId, seq, {
		kind: "state_change",
		stream: "system",
		payload: {
			type: "turn_end",
			message: {
				role: "assistant",
				usage: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead ?? 0,
					cacheWrite: usage.cacheWrite ?? 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: usage.costTotal,
					},
				},
			},
		},
	});
}

/**
 * Claude-code single-shot `result` envelope (warren-87f9). Burrow's
 * jsonl-claude parser maps it to state_change/system; the bridge
 * sniffs the payload shape to extract cost.
 */
export function claudeResult(
	burrowRunId: string,
	seq: number,
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		totalCostUsd: number;
		isError?: boolean;
	},
): RunEvent {
	return evt(burrowRunId, seq, {
		kind: "state_change",
		stream: "system",
		payload: {
			type: "result",
			subtype: "success",
			is_error: usage.isError ?? false,
			total_cost_usd: usage.totalCostUsd,
			usage: {
				input_tokens: usage.inputTokens,
				output_tokens: usage.outputTokens,
				cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
				cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
			},
		},
	});
}

/**
 * Default bridge-test fixture: an in-memory warren db with one
 * agent + project + run, returning the ids tests need. Caller is
 * responsible for `await db.close()` in afterEach. Keeps the test
 * files free of boilerplate so the per-domain split stays focused.
 */
export interface BridgeFixtureIds {
	readonly runId: string;
	readonly burrowId: string;
	readonly burrowRunId: string;
}

export async function seedBridgeRun(
	repos: Repos,
	overrides?: Partial<BridgeFixtureIds>,
): Promise<BridgeFixtureIds> {
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const burrowId = overrides?.burrowId ?? "bur_aaaaaaaaaaaa";
	const burrowRunId = overrides?.burrowRunId ?? "run_zzzzzzzzzzzz";
	const run = await repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		prompt: "p",
		renderedAgentJson: {},
		trigger: "manual",
		burrowId,
		burrowRunId,
	});
	return { runId: run.id, burrowId, burrowRunId };
}
