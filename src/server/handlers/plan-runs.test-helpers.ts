import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import type { SpawnFn, SpawnOptions, SpawnResult } from "../../projects/clone.ts";
import { RunEventBroker } from "../../runs/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { SeedsTracker } from "../../tracker/seeds-tracker.ts";
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

/** An inert provider — the plan-run handler tests never reach the runtime seam. */
export function poolFor(): FakeProvider {
	return new FakeProvider();
}

export interface BuildDepsInput {
	repos: Repos;
	sdSpawn: SpawnFn;
	bridges?: BridgeRegistry;
	logger?: Logger;
	/** Wire the git `spawn` seam so the plan-run handler refreshes the clone (warren-6d60). */
	spawn?: SpawnFn;
	/** Stub the project refresher so tests assert the refresh without shelling out (warren-6d60). */
	refreshProjectFn?: ServerDeps["refreshProjectFn"];
	/** Event-stream concurrency caps (warren-25f6). Omitted ⇒ uncapped. */
	streamLimiter?: ServerDeps["streamLimiter"];
}

export async function depsFor(input: BuildDepsInput): Promise<ServerDeps> {
	const broker = new RunEventBroker();
	const provider = poolFor();
	return {
		repos: input.repos,
		runtimeProvider: provider,
		forge: new FakeForge(),
		broker,
		bridges:
			input.bridges ??
			createBridgeRegistry({
				repos: input.repos,
				broker,
				runtimeProvider: provider,
				bridge: async () => ({ written: 0, skipped: 0, errored: false }),
			}),
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: input.logger ?? silentLogger,
		uiDistDir: null,
		seedsCli: { sdBinary: "sd", spawn: input.sdSpawn },
		issueTracker: new SeedsTracker({ sdBinary: "sd", spawn: input.sdSpawn }),
		...(input.spawn !== undefined ? { spawn: input.spawn } : {}),
		...(input.refreshProjectFn !== undefined ? { refreshProjectFn: input.refreshProjectFn } : {}),
		...(input.streamLimiter !== undefined ? { streamLimiter: input.streamLimiter } : {}),
	};
}

export interface CapturedLog {
	level: "info" | "warn" | "error";
	obj: object;
	msg: string | undefined;
}

export function makeCaptureLogger(captured: CapturedLog[]): Logger {
	return {
		info(obj, msg) {
			captured.push({ level: "info", obj, msg });
		},
		warn(obj, msg) {
			captured.push({ level: "warn", obj, msg });
		},
		error(obj, msg) {
			captured.push({ level: "error", obj, msg });
		},
	};
}

export function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

export interface PlanRunFixture {
	db: WarrenDb;
	repos: Repos;
	projectId: string;
	seedyProjectId: string;
}

export async function setupPlanRunFixture(): Promise<PlanRunFixture> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);

	await repos.agents.upsert({
		name: "claude-code",
		renderedJson: {
			name: "claude-code",
			version: 1,
			sections: { system: "you are claude" },
			resolvedFrom: [],
			frontmatter: {},
		},
	});

	const seedy = await repos.projects.create({
		gitUrl: "https://github.com/x/seedy.git",
		localPath: "/tmp/seedy",
		defaultBranch: "main",
		hasSeeds: true,
	});
	const bare = await repos.projects.create({
		gitUrl: "https://github.com/x/bare.git",
		localPath: "/tmp/bare",
		defaultBranch: "main",
		hasSeeds: false,
	});
	return {
		db,
		repos,
		projectId: bare.id,
		seedyProjectId: seedy.id,
	};
}
