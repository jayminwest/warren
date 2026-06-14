import type { PlotEvent } from "@os-eco/plot-cli";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type {
	AnswerPlotQuestionRequest,
	AnswerPlotQuestionResult,
	PlotAggregator,
	PlotQuestionAnswerer,
	PlotResolver,
	PlotSummary,
} from "../../plots/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { createBridgeRegistry } from "../bridges.ts";
import type { Logger, ServeHandle, ServerDeps } from "../types.ts";

export const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
};

function stubFetch(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function poolFor(repos: Repos): Promise<BurrowClientPool> {
	await repos.workers.upsert({ name: "local", url: "unix:///tmp/x.sock" });
	const pool = new BurrowClientPool({ repos });
	const client = new BurrowClient({
		config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
		fetch: stubFetch(async () => jsonRes(404, { error: { code: "not_found", message: "stub" } })),
	});
	pool.register("local", client);
	return pool;
}

export interface BuildDepsInput {
	repos: Repos;
	plotAggregator?: PlotAggregator;
	plotResolver?: PlotResolver;
	plotQuestionAnswerer?: PlotQuestionAnswerer;
}

export async function depsFor(input: BuildDepsInput): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const pool = await poolFor(input.repos);
	return {
		repos: input.repos,
		burrowClientPool: pool,
		broker,
		bridges: createBridgeRegistry({
			repos: input.repos,
			broker,
			burrowClientPool: pool,
			bridge: async () => ({ written: 0, skipped: 0, errored: false }),
		}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(input.plotAggregator !== undefined ? { plotAggregator: input.plotAggregator } : {}),
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
		...(input.plotQuestionAnswerer !== undefined
			? { plotQuestionAnswerer: input.plotQuestionAnswerer }
			: {}),
	};
}

export function fakeResolver(map: Record<string, ProjectRow | null>): {
	resolver: PlotResolver;
	calls: string[];
} {
	const calls: string[] = [];
	const resolver: PlotResolver = {
		async resolve(plotId) {
			calls.push(plotId);
			return map[plotId] ?? null;
		},
	};
	return { resolver, calls };
}

export async function seedProject(
	repos: Repos,
	over: Partial<ProjectRow> & { id: string },
): Promise<ProjectRow> {
	return repos.projects.create({
		id: over.id,
		gitUrl: over.gitUrl ?? `https://example.test/${over.id}.git`,
		defaultBranch: over.defaultBranch ?? "main",
		localPath: over.localPath ?? `/tmp/projects/${over.id}`,
		hasPlot: over.hasPlot ?? false,
		hasSeeds: over.hasSeeds ?? false,
	});
}

export function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

export function fakeAggregator(rows: readonly PlotSummary[]): {
	agg: PlotAggregator;
	state: { invalidates: string[] };
} {
	const state = { invalidates: [] as string[] };
	const agg: PlotAggregator = {
		async listSummaries() {
			return rows;
		},
		async listNeedsAttention() {
			return [];
		},
		async countNeedsAttention() {
			return 0;
		},
		invalidate(projectId) {
			if (projectId) state.invalidates.push(projectId);
		},
	};
	return { agg, state };
}

export interface FakeQuestionAnswererCall {
	readonly input: AnswerPlotQuestionRequest;
}

export function fakeQuestionAnswerer(result: AnswerPlotQuestionResult): {
	answerer: PlotQuestionAnswerer;
	calls: FakeQuestionAnswererCall[];
} {
	const calls: FakeQuestionAnswererCall[] = [];
	const answerer: PlotQuestionAnswerer = {
		async answer(input) {
			calls.push({ input });
			return result;
		},
	};
	return { answerer, calls };
}

export function answeredEvent(over: {
	question_id?: string;
	text?: string;
	at?: string;
	actor?: string;
}): PlotEvent {
	return {
		type: "question_answered",
		actor: over.actor ?? "user:alice",
		at: over.at ?? "2026-05-18T05:00:00Z",
		data: {
			question_id: over.question_id ?? "2026-05-18T04:00:00Z",
			text: over.text ?? "ship oauth",
		},
	};
}
