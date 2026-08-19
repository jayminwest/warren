/**
 * Shared fixtures for `src/runs/stream/*.test.ts`. Split out of the
 * monolithic `src/runs/stream.test.ts` as part of warren-041e /
 * pl-9088 step 5; the helpers are deliberately small and have no
 * Bun-test imports so a `*.test.ts` can be the consumer.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { StreamEventView } from "./types.ts";

/**
 * Inert `RuntimeProvider` stub (warren-1fce). Every stream test either overrides
 * the bridge's `source` (so the provider's `streamEvents`/`status`/`cancel` are
 * never reached) or injects a bespoke provider for the path under test. This
 * stub satisfies the now-required `runtimeProvider` field while making an
 * accidental live call fail loudly instead of hitting a real backend — the
 * provider-only successor to the old `makePool()` burrow-client fixture.
 */
export function makeProvider(): RuntimeProvider {
	const unexpected = (name: string) => (): never => {
		throw new Error(
			`makeProvider stub: provider.${name}() must not be called — pass a source/bridge override or a bespoke provider`,
		);
	};
	return {
		capabilities: {
			previewPorts: false,
			networkPolicy: "none",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: false,
			workspaceArchive: false,
			workspaceGc: false,
		},
		kind: "local",
		create: unexpected("create"),
		streamEvents: unexpected("streamEvents"),
		status: unexpected("status"),
		sendMessage: unexpected("sendMessage"),
		cancel: unexpected("cancel"),
		workspaceInfo: unexpected("workspaceInfo"),
		finalize: unexpected("finalize"),
		terminate: unexpected("terminate"),
	};
}

/**
 * Build a provider-neutral stream event (the bridge's `StreamEventView`). Prior
 * to warren-1fce this returned burrow's `RunEvent`; the bridge only ever reads
 * the `{seq, ts, kind, stream, payload}` view, satisfied by both that and the
 * seam's `NormalizedEvent`, so the fixture drops the burrow-cli dependency.
 */
export function evt(
	_sandboxRunId: string,
	seq: number,
	overrides: Partial<StreamEventView> = {},
): StreamEventView {
	return {
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

export function source(
	events: StreamEventView[],
): (signal: AbortSignal) => AsyncIterable<StreamEventView> {
	return () => asyncIter(events);
}

/**
 * Build a pi-shaped `agent_end` envelope as it lands after burrow's pi
 * parser (kind="state_change", stream="system", payload.type="agent_end").
 * Mirrors burrow `src/runtime/parsers/pi.ts:86-98` (warren-36c0). The
 * synthetic `{kind:"agent_end"}` shape never appears in production.
 */
export function piAgentEnd(sandboxRunId: string, seq: number): StreamEventView {
	return evt(sandboxRunId, seq, {
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
	sandboxRunId: string,
	seq: number,
	usage: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		costTotal: number;
	},
): StreamEventView {
	return evt(sandboxRunId, seq, {
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
	sandboxRunId: string,
	seq: number,
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		totalCostUsd: number;
		isError?: boolean;
	},
): StreamEventView {
	return evt(sandboxRunId, seq, {
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
	readonly sandboxId: string;
	readonly sandboxRunId: string;
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
	const sandboxId = overrides?.sandboxId ?? "bur_aaaaaaaaaaaa";
	const sandboxRunId = overrides?.sandboxRunId ?? "run_zzzzzzzzzzzz";
	const run = await repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		prompt: "p",
		renderedAgentJson: {},
		trigger: "manual",
		sandboxId,
		sandboxRunId,
	});
	return { runId: run.id, sandboxId, sandboxRunId };
}
