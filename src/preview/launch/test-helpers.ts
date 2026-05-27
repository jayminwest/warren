/**
 * Shared test fixtures for the `launch/` split (warren-62a7 / pl-9088
 * step 9). Each launch test file (`orchestrate`, `setup`, `probe-loop`)
 * reaches for these instead of redefining the same fakes.
 */

import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { DrizzleAdapter } from "../../db/repos/drizzle-adapter.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { ServerPreviewConfig } from "../../warren-config/index.ts";
import { PreviewPortAllocator } from "../port-allocator.ts";
import type { PreviewSidecarsClient } from "./types.ts";

export const PREVIEW_CONFIG: ServerPreviewConfig = {
	type: "server",
	command: "bun run dev",
	port: 3000,
};

export interface FakeSidecar {
	client: PreviewSidecarsClient;
	readonly creates: Array<{
		burrowId: string;
		command: readonly string[];
		env?: Record<string, string>;
		inboundPortForward?: { hostPort: number; sandboxPort: number };
		readinessPath?: string;
	}>;
	readonly deletes: Array<{ burrowId: string; sidecarId: string }>;
	logs: { stdout: string; stderr: string };
	createImpl?: () => Promise<{ id: string; state: string }>;
	/**
	 * Per-sidecar-id status queue (warren-d9e7). Each successive `get()` call
	 * pops the next status; once exhausted, the last value is returned forever.
	 * Defaults to `{state: 'exited', exitCode: 0}` when no entries are seeded,
	 * which keeps the dev-server-sidecar path (no status polling) unchanged.
	 */
	readonly statusQueue: Map<string, Array<{ state: string; exitCode: number | null }>>;
}

type CreateInput = Parameters<PreviewSidecarsClient["create"]>[0];

export function fakeSidecars(
	initialLogs: { stdout: string; stderr: string } = { stdout: "", stderr: "" },
): FakeSidecar {
	const creates: FakeSidecar["creates"] = [];
	const deletes: FakeSidecar["deletes"] = [];
	const statusQueue = new Map<string, Array<{ state: string; exitCode: number | null }>>();
	const state: FakeSidecar = {
		client: {} as PreviewSidecarsClient,
		creates,
		deletes,
		logs: { ...initialLogs },
		statusQueue,
	};
	let nextSidecarSeq = 0;
	const client: PreviewSidecarsClient = {
		async create(input: CreateInput) {
			creates.push({
				burrowId: input.burrowId,
				command: [...input.command],
				...(input.env !== undefined ? { env: { ...input.env } } : {}),
				...(input.inboundPortForward !== undefined
					? { inboundPortForward: input.inboundPortForward }
					: {}),
				...(input.readinessPath !== undefined ? { readinessPath: input.readinessPath } : {}),
			});
			if (state.createImpl !== undefined) return state.createImpl();
			nextSidecarSeq++;
			return { id: `sc_test_${nextSidecarSeq}`, state: "live" };
		},
		async logs() {
			return { stdout: state.logs.stdout, stderr: state.logs.stderr };
		},
		async delete(burrowId: string, sidecarId: string) {
			deletes.push({ burrowId, sidecarId });
		},
		async get(_burrowId: string, sidecarId: string) {
			const queue = statusQueue.get(sidecarId);
			if (queue === undefined || queue.length === 0) {
				return { state: "exited", exitCode: 0 };
			}
			return queue.length === 1
				? (queue[0] as { state: string; exitCode: number | null })
				: (queue.shift() as { state: string; exitCode: number | null });
		},
	};
	state.client = client;
	return state;
}

export function fakeFetch(responses: Array<Response | (() => Response)>): {
	fetch: typeof fetch;
	calls: string[];
} {
	const calls: string[] = [];
	let i = 0;
	const fn = (async (input: URL | RequestInfo): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		const next = responses[i++];
		if (next === undefined) throw new Error("fakeFetch: out of responses");
		return typeof next === "function" ? next() : next;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

// warren-44ed / pl-592f step 2: phase-1 now uses tcpConnectOnce (raw TCP)
// instead of fetch. Tests that want to exercise phase-2 readiness logic
// inject `tcpConnect: alwaysConnected` so phase-1 transitions on the first
// poll; tests that exercise phase-1 itself supply explicit sequences via
// `fakeTcp`.
export const alwaysConnected: (
	host: string,
	port: number,
	timeoutMs: number,
) => Promise<"connected" | "not_connected"> = async () => "connected";

export const alwaysRefused: (
	host: string,
	port: number,
	timeoutMs: number,
) => Promise<"connected" | "not_connected"> = async () => "not_connected";

export function fakeTcp(outcomes: Array<"connected" | "not_connected">): {
	tcpConnect: (
		host: string,
		port: number,
		timeoutMs: number,
	) => Promise<"connected" | "not_connected">;
	calls: number;
} {
	const state = { calls: 0 };
	const tcpConnect = async (): Promise<"connected" | "not_connected"> => {
		const next = outcomes[state.calls++];
		if (next === undefined) {
			throw new Error("fakeTcp: out of outcomes");
		}
		return next;
	};
	return {
		tcpConnect,
		get calls() {
			return state.calls;
		},
	};
}

export interface LaunchTestEnv {
	db: WarrenDb;
	repos: Repos;
	allocator: PreviewPortAllocator;
	runId: string;
	burrowId: string;
}

/**
 * Provision the shared `beforeEach` fixture used by every orchestrator-level
 * launch test (in-memory db, repos, a single agent + project + run, and a
 * three-port allocator). Tests that need a different allocator range build
 * one locally on the returned `db`.
 */
export async function setupLaunchEnv(): Promise<LaunchTestEnv> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "agent", renderedJson: { sections: {} } });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const run = await repos.runs.create({
		agentName: "agent",
		projectId: project.id,
		prompt: "p",
		renderedAgentJson: {},
		trigger: "manual",
		burrowId: "bur_aaaa",
	});
	const allocator = new PreviewPortAllocator(DrizzleAdapter.for(db), { start: 40000, end: 40002 });
	return { db, repos, allocator, runId: run.id, burrowId: "bur_aaaa" };
}
