import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type {
	CreatePlotRequest,
	CreatePlotResult,
	PlotAggregator,
	PlotCreator,
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
	plotCreator?: PlotCreator;
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
		...(input.plotCreator !== undefined ? { plotCreator: input.plotCreator } : {}),
	};
}

interface FakeCreatorCall {
	readonly input: CreatePlotRequest;
}

export function fakeCreator(result: CreatePlotResult): {
	creator: PlotCreator;
	calls: FakeCreatorCall[];
} {
	const calls: FakeCreatorCall[] = [];
	const creator: PlotCreator = {
		async create(input) {
			calls.push({ input });
			return result;
		},
	};
	return { creator, calls };
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

interface FakeAggregatorCalls {
	calls: Array<{ status?: string }>;
	invalidates: Array<string | undefined>;
}

export function fakeAggregator(rows: readonly PlotSummary[]): {
	agg: PlotAggregator;
	state: FakeAggregatorCalls;
} {
	const state: FakeAggregatorCalls = { calls: [], invalidates: [] };
	const agg: PlotAggregator = {
		async listSummaries(q) {
			state.calls.push({ ...(q?.status !== undefined ? { status: q.status } : {}) });
			if (q?.status !== undefined) {
				return rows.filter((r) => r.status === q.status);
			}
			return rows;
		},
		async listNeedsAttention() {
			return [];
		},
		async countNeedsAttention() {
			return 0;
		},
		invalidate(projectId) {
			state.invalidates.push(projectId);
		},
	};
	return { agg, state };
}

export function summary(over: Partial<PlotSummary>): PlotSummary {
	return {
		id: "pt-a",
		name: "A",
		status: "active",
		intent_goal_preview: "",
		attachments_count: 0,
		last_event_ts: "2026-05-18T00:00:00Z",
		last_event_actor: "user:operator",
		project_id: "proj-a",
		...over,
	};
}
