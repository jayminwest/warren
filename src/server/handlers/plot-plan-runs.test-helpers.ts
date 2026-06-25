/**
 * Shared helpers + fixtures for the `POST /plot-plan-runs` test suites
 * (warren-59db / pl-7c4f). Extracted from plot-plan-runs.test.ts so the
 * happy-path/filter tests (plot-plan-runs.test.ts) and the
 * validation/error tests (plot-plan-runs.validation.test.ts) share a
 * single copy of every stub/fixture. Mirrors the precedent of
 * src/diagnostics/checks.test-helpers.ts (warren-7a15) and
 * src/server/handlers/projects.test-helpers.ts (warren-a715).
 */

import type { Attachment } from "@os-eco/plot-cli";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type { PlanRunPlotActivator, PlanRunPlotAppender } from "../../plan-runs/plot-appender.ts";
import type {
	PlanSynthesizer,
	SynthesizePlanInput,
	SynthesizePlanResult,
} from "../../plot-plan-runs/index.ts";
import type {
	PlotReader,
	PlotResolver,
	ReadPlotRequest,
	ReadPlotResult,
} from "../../plots/index.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../../projects/clone.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { createBridgeRegistry } from "../bridges.ts";
import type { BridgeRegistry, Logger, ServeHandle, ServerDeps } from "../types.ts";

export const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
};

export function stubFetch(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

export function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export async function poolFor(repos: Repos): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stubFetch(async () => jsonRes(404, { error: { code: "not_found", message: "stub" } })),
	});
	pool.register("local", client);
	return pool;
}

export interface SdCall {
	cmd: readonly string[];
}

export function makeSdSpawn(
	calls: SdCall[],
	responses: { match: (cmd: readonly string[]) => boolean; result: SpawnResult }[],
): SpawnFn {
	return async (cmd: readonly string[], _opts: SpawnOptions): Promise<SpawnResult> => {
		calls.push({ cmd });
		const matched = responses.find((r) => r.match(cmd));
		if (matched !== undefined) return matched.result;
		return { stdout: "", stderr: `no stub for ${cmd.join(" ")}`, exitCode: 1 };
	};
}

export function planShowResult(planId: string, status: string, children: string[]): SpawnResult {
	return {
		stdout: JSON.stringify({
			success: true,
			plan: {
				id: planId,
				status,
				children,
				sections: { steps: children.map((title) => ({ title, blocks: [] })) },
			},
		}),
		stderr: "",
		exitCode: 0,
	};
}

export function seedShowResult(id: string, status: "open" | "closed"): SpawnResult {
	return {
		stdout: JSON.stringify({
			success: true,
			issue: { id, status, blockedBy: [] },
		}),
		stderr: "",
		exitCode: 0,
	};
}

export function makeAttachment(
	id: string,
	type: Attachment["type"],
	ref: string,
	role = "tracks",
): Attachment {
	return {
		id,
		type,
		ref,
		role,
		added_at: "2026-05-19T00:00:00.000Z",
		added_by: "user:operator",
	};
}

export function makePlotReader(envelope: ReadPlotResult): PlotReader {
	return {
		async read(_input: ReadPlotRequest) {
			return envelope;
		},
	};
}

export function makePlotResolver(map: Record<string, ProjectRow>): PlotResolver {
	return {
		async resolve(plotId) {
			return map[plotId] ?? null;
		},
	};
}

export interface SynthesizeCall extends SynthesizePlanInput {}

export function makeSynthesizer(opts: {
	calls?: SynthesizeCall[];
	result?: SynthesizePlanResult;
	error?: Error;
}): PlanSynthesizer {
	const calls = opts.calls ?? [];
	return {
		async synthesize(input) {
			calls.push(input);
			if (opts.error) throw opts.error;
			return (
				opts.result ?? {
					parentSeedId: "wa-syn",
					planId: "pl-syn",
					children: [...input.candidateSeedIds],
				}
			);
		},
	};
}

export interface BuildDepsInput {
	repos: Repos;
	sdSpawn: SpawnFn;
	bridges?: BridgeRegistry;
	planRunPlotAppender?: PlanRunPlotAppender;
	planRunPlotActivator?: PlanRunPlotActivator;
	planSynthesizer?: PlanSynthesizer;
	plotReader?: PlotReader;
	plotResolver?: PlotResolver;
	logger?: Logger;
}

export async function depsFor(input: BuildDepsInput): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const pool = await poolFor(input.repos);
	return {
		repos: input.repos,
		burrowClientPool: pool,
		broker,
		bridges:
			input.bridges ??
			createBridgeRegistry({
				repos: input.repos,
				broker,
				burrowClientPool: pool,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: input.logger ?? silentLogger,
		uiDistDir: null,
		seedsCli: { sdBinary: "sd", spawn: input.sdSpawn },
		...(input.planRunPlotAppender !== undefined
			? { planRunPlotAppender: input.planRunPlotAppender }
			: {}),
		...(input.planRunPlotActivator !== undefined
			? { planRunPlotActivator: input.planRunPlotActivator }
			: {}),
		...(input.planSynthesizer !== undefined ? { planSynthesizer: input.planSynthesizer } : {}),
		...(input.plotReader !== undefined ? { plotReader: input.plotReader } : {}),
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
	};
}

export function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

export function plotEnvelope(opts: { attachments: Attachment[]; id?: string }): ReadPlotResult {
	return {
		id: opts.id ?? "plot-deadbeef",
		name: "Test Plot",
		status: "active",
		intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
		attachments: opts.attachments,
		event_log: [],
	};
}
