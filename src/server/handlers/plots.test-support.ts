/**
 * Shared test scaffolding for the Plot HTTP handler suites
 * (warren-332b / pl-369d). Extracted from the monolithic
 * `plots.test.ts` preamble so the per-domain suites
 * (`plots.detail.test.ts`, `plots.intent.test.ts`,
 * `plots.status.test.ts`, `plots.attachments.test.ts`) share one copy of
 * the seam stubs / dep builders rather than duplicating ~200 lines each.
 *
 * Not a `*.test.ts` file — holds no `describe`/`test` blocks, so the Bun
 * test runner ignores it; the suites import the helpers they need.
 */

import type { Attachment, Intent, PlotEvent } from "@os-eco/plot-cli";
import { BurrowClient, BurrowClientPool } from "../../burrow-client/index.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type {
	AttachPlotRequest,
	AttachPlotResult,
	CreatePlotRequest,
	CreatePlotResult,
	DetachPlotRequest,
	DetachPlotResult,
	PlotAggregator,
	PlotAttacher,
	PlotCreator,
	PlotReader,
	PlotResolver,
	PlotSummary,
	ReadPlotRequest,
	ReadPlotResult,
} from "../../plots/index.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { createBridgeRegistry } from "../bridges.ts";
import type { Logger, ServeHandle, ServerDeps } from "../types.ts";

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

export interface BuildDepsInput {
	repos: Repos;
	plotAggregator?: PlotAggregator;
	plotCreator?: import("../../plots/index.ts").PlotCreator;
	plotReader?: PlotReader;
	plotResolver?: PlotResolver;
	plotIntentEditor?: import("../../plots/index.ts").PlotIntentEditor;
	plotRenamer?: import("../../plots/index.ts").PlotRenamer;
	plotStatusChanger?: import("../../plots/index.ts").PlotStatusChanger;
	plotAttacher?: import("../../plots/index.ts").PlotAttacher;
	plotPrMerger?: import("../../plots/index.ts").PlotPrMerger;
	plotQuestionAnswerer?: import("../../plots/index.ts").PlotQuestionAnswerer;
	plotSyncer?: import("../../plots/index.ts").PlotSyncer;
	planChildAdopter?: import("../../plots/index.ts").PlanChildAdopter;
	seedsCli?: import("../../seeds-cli/index.ts").SeedsCliDeps;
	autoOpenToken?: string;
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
		...(input.plotReader !== undefined ? { plotReader: input.plotReader } : {}),
		...(input.plotResolver !== undefined ? { plotResolver: input.plotResolver } : {}),
		...(input.plotIntentEditor !== undefined ? { plotIntentEditor: input.plotIntentEditor } : {}),
		...(input.plotRenamer !== undefined ? { plotRenamer: input.plotRenamer } : {}),
		...(input.plotStatusChanger !== undefined
			? { plotStatusChanger: input.plotStatusChanger }
			: {}),
		...(input.plotAttacher !== undefined ? { plotAttacher: input.plotAttacher } : {}),
		...(input.plotPrMerger !== undefined ? { plotPrMerger: input.plotPrMerger } : {}),
		...(input.autoOpenToken !== undefined
			? {
					autoOpenPr: {
						enabled: true,
						token: input.autoOpenToken,
						warrenBaseUrl: null,
					},
				}
			: {}),
		...(input.plotQuestionAnswerer !== undefined
			? { plotQuestionAnswerer: input.plotQuestionAnswerer }
			: {}),
		...(input.plotSyncer !== undefined ? { plotSyncer: input.plotSyncer } : {}),
		...(input.planChildAdopter !== undefined ? { planChildAdopter: input.planChildAdopter } : {}),
		...(input.seedsCli !== undefined ? { seedsCli: input.seedsCli } : {}),
	};
}

export interface FakeCreatorCall {
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

export interface FakeReaderCall {
	readonly input: ReadPlotRequest;
}

export function fakeReader(result: ReadPlotResult): {
	reader: PlotReader;
	calls: FakeReaderCall[];
} {
	const calls: FakeReaderCall[] = [];
	const reader: PlotReader = {
		async read(input) {
			calls.push({ input });
			return result;
		},
	};
	return { reader, calls };
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

export interface FakeAggregatorCalls {
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

interface FakeAttacherCall {
	readonly kind: "attach" | "detach";
	readonly attach?: AttachPlotRequest;
	readonly detach?: DetachPlotRequest;
}

export function fakeAttacher(over: { attach?: AttachPlotResult; detach?: DetachPlotResult }): {
	attacher: PlotAttacher;
	calls: FakeAttacherCall[];
} {
	const calls: FakeAttacherCall[] = [];
	const attacher: PlotAttacher = {
		async attach(input) {
			calls.push({ kind: "attach", attach: input });
			if (over.attach === undefined) throw new Error("no attach result configured");
			return over.attach;
		},
		async detach(input) {
			calls.push({ kind: "detach", detach: input });
			if (over.detach === undefined) throw new Error("no detach result configured");
			return over.detach;
		},
	};
	return { attacher, calls };
}

export const sampleIntent: Intent = {
	goal: "",
	non_goals: [],
	constraints: [],
	success_criteria: [],
};

export function attachResult(over: Partial<AttachPlotResult>): AttachPlotResult {
	const attachment: Attachment = {
		id: "att-001",
		type: "seeds_issue",
		ref: "proj-abcd",
		role: "tracks",
		added_at: "2026-05-18T03:00:00Z",
		added_by: "user:alice",
		...(over.attachment ?? {}),
	};
	const ev: PlotEvent = {
		type: "attachment_added",
		actor: "user:alice",
		at: "2026-05-18T03:00:00Z",
		data: {
			id: attachment.id,
			type: attachment.type,
			ref: attachment.ref,
			role: attachment.role,
		},
	};
	return {
		id: over.id ?? "pt-at",
		name: over.name ?? "A",
		status: over.status ?? "active",
		intent: over.intent ?? sampleIntent,
		attachments: over.attachments ?? [attachment],
		event_log: over.event_log ?? [ev],
		attachment,
	};
}

export function detachResult(over: Partial<DetachPlotResult>): DetachPlotResult {
	const ev: PlotEvent = {
		type: "attachment_removed",
		actor: "user:alice",
		at: "2026-05-18T03:30:00Z",
		data: { id: over.removed_id ?? "att-001" },
	};
	return {
		id: over.id ?? "pt-at",
		name: over.name ?? "A",
		status: over.status ?? "active",
		intent: over.intent ?? sampleIntent,
		attachments: over.attachments ?? [],
		event_log: over.event_log ?? [ev],
		removed_id: over.removed_id ?? "att-001",
	};
}

export { createRepos, type ProjectRow, type Repos };
