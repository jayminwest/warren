import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile, SpawnResult } from "../../sandbox/types.ts";
import { assertFixtureHermetic, fixtureGitOrThrow } from "../../workspace/git/test-fixture.ts";
import { initRepo } from "../../workspace/git/worktree.ts";
import type { AgentRuntimeAdapter } from "../adapters/index.ts";
import type { RunSpec } from "../contract.ts";
import { RuntimeProviderError, RuntimeRunNotFoundError } from "../errors.ts";
import { LocalEngine, type LocalEngineDeps } from "./engine.ts";
import { readLocalRunManifest } from "./manifest.ts";
import { localHomePath, localWorkspacePath, resolveLocalStateRoots } from "./paths.ts";
import { LocalRunStore } from "./run-store.ts";

/* -------------------------------------------------------------------------- */
/* Hermetic git fixture (warren-cfa7 posture)                                  */
/* -------------------------------------------------------------------------- */

const savedGitEnv: Record<string, string | undefined> = {};

beforeAll(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_")) {
			savedGitEnv[key] = process.env[key];
			delete process.env[key];
		}
	}
});

afterAll(() => {
	for (const [key, value] of Object.entries(savedGitEnv)) {
		if (value !== undefined) process.env[key] = value;
	}
});

async function bootstrapRepo(path: string): Promise<void> {
	await initRepo({ targetPath: path, initialBranch: "main" });
	writeFileSync(join(path, "README.md"), "# repo\n");
	await fixtureGitOrThrow(path, ["config", "user.email", "host@example.com"]);
	await fixtureGitOrThrow(path, ["config", "user.name", "Host"]);
	await fixtureGitOrThrow(path, ["add", "."]);
	await fixtureGitOrThrow(path, ["commit", "-m", "init"]);
	await assertFixtureHermetic(path);
}

/* -------------------------------------------------------------------------- */
/* Fake adapter + child                                                        */
/* -------------------------------------------------------------------------- */

const fakeAdapter: AgentRuntimeAdapter = {
	runtimeId: "fake",
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: () => ({ argv: ["fake"], stdin: "do it" }),
	parseEvents: (line: string) => [
		JSON.parse(line) as { kind: "text"; stream: "stdout"; payload: unknown },
	],
} as unknown as AgentRuntimeAdapter;

function immediateProc(lines: readonly string[], exitCode = 0): SpawnResult {
	const encoder = new TextEncoder();
	const body = lines.map((l) => `${l}\n`).join("");
	const stdout = new ReadableStream<Uint8Array>({
		start(ctrl) {
			if (body !== "") ctrl.enqueue(encoder.encode(body));
			ctrl.close();
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(ctrl) {
			ctrl.close();
		},
	});
	return {
		pid: 4321,
		stdout,
		stderr,
		exited: Promise.resolve(exitCode),
		cancel: () => {},
		closeStdin: () => Promise.resolve(),
		writeStdin: () => Promise.resolve(),
	};
}

const TERMINAL_LINE = JSON.stringify({
	kind: "state_change",
	stream: "system",
	payload: { type: "result" },
});

interface Harness {
	readonly engine: LocalEngine;
	readonly dataDir: string;
	readonly repo: string;
	readonly profiles: SandboxProfile[];
	readonly store: LocalRunStore;
	cleanup(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
	const dataDir = await mkdtemp(join(tmpdir(), "warren-engine-data-"));
	const repo = await mkdtemp(join(tmpdir(), "warren-engine-repo-"));
	await bootstrapRepo(repo);
	const profiles: SandboxProfile[] = [];
	const store = new LocalRunStore();
	const deps: LocalEngineDeps = {
		serverEnv: { WARREN_DATA_DIR: dataDir, WARREN_BIND_PORT: "8181" },
		store,
		drive: {
			spawn: (profile) => {
				profiles.push(profile);
				return Promise.resolve(immediateProc([TERMINAL_LINE]));
			},
			registry: { get: (id) => (id === "fake" ? fakeAdapter : undefined) },
		},
	};
	return {
		engine: new LocalEngine(deps),
		dataDir,
		repo,
		profiles,
		store,
		cleanup: async () => {
			await rm(dataDir, { recursive: true, force: true });
			await rm(repo, { recursive: true, force: true });
		},
	};
}

function makeSpec(h: Harness, runId: string, overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId,
		originUrl: "https://github.com/o/r.git",
		branch: `warren/${runId}`,
		baseBranch: "main",
		hostClonePathHint: h.repo,
		runtimeId: "fake",
		prompt: "do it",
		mode: "batch",
		network: "open",
		seedFiles: [{ path: ".warren/agent.json", contents: '{"name":"fake"}' }],
		env: {},
		...overrides,
	};
}

/** Poll status until the record terminalizes (the drive loop is async). */
async function awaitTerminal(
	engine: LocalEngine,
	providerRunId: string,
): Promise<Awaited<ReturnType<LocalEngine["status"]>>> {
	for (let i = 0; i < 200; i++) {
		const status = await engine.status({ runId: providerRunId, sandboxId: "", providerRunId });
		if (status.phase === "succeeded" || status.phase === "failed" || status.phase === "cancelled") {
			return status;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("run never terminalized");
}

describe("LocalEngine.create", () => {
	test("materializes a worktree, writes seed files, and drives the run to succeeded", async () => {
		const h = await makeHarness();
		try {
			const handle = await h.engine.create(makeSpec(h, "run_e1"));
			expect(handle.sandboxId).toBe("local-run_e1");
			expect(handle.providerRunId).toBe("run_e1");

			const status = await awaitTerminal(h.engine, handle.providerRunId);
			expect(status.phase).toBe("succeeded");
			expect(status.terminalReason).toBe("completed");
			expect(status.lastEventSeq).toBeGreaterThan(0);
			expect(status.lastEventTs).not.toBeNull();

			const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: h.dataDir });
			const workspacePath = localWorkspacePath(roots, handle.sandboxId);
			// the worktree exists and carries the seed drop
			expect(readFileSync(join(workspacePath, ".warren/agent.json"), "utf8")).toBe(
				'{"name":"fake"}',
			);
			// the run's private HOME exists and is NOT the workspace (warren-c865)
			const homePath = localHomePath(roots, handle.sandboxId);
			expect(existsSync(homePath)).toBe(true);
			expect(homePath).not.toBe(workspacePath);
			// the manifest persists the materialization for GC
			const manifest = await readLocalRunManifest(roots, handle.sandboxId);
			expect(manifest?.source.kind).toBe("worktree");
			expect(manifest?.branch).toBe("warren/run_e1");
			// the profile binds the real HOME + the worktree's git common dir
			expect(h.profiles[0]?.home).toBe(homePath);
			expect(h.profiles[0]?.workspaceGitdir).toBeDefined();
		} finally {
			await h.cleanup();
		}
	});

	test("injects the provider-owned callback URL when a token rides the domain env", async () => {
		const h = await makeHarness();
		try {
			await h.engine.create(makeSpec(h, "run_e2", { env: { WARREN_API_TOKEN: "tok" } }));
			await awaitTerminal(h.engine, "run_e2");
			expect(h.profiles[0]?.setEnv.WARREN_API_URL).toBe("http://localhost:8181");
			expect(h.profiles[0]?.setEnv.BUN_INSTALL_CACHE_DIR).toBe("/tmp/bun-install-cache");
		} finally {
			await h.cleanup();
		}
	});

	test("rejects a RunSpec with no hostClonePathHint", async () => {
		const h = await makeHarness();
		try {
			await expect(
				h.engine.create(makeSpec(h, "run_e3", { hostClonePathHint: undefined })),
			).rejects.toThrow(RuntimeProviderError);
		} finally {
			await h.cleanup();
		}
	});

	test("cleans up the dirs when materialization fails", async () => {
		const h = await makeHarness();
		try {
			const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: h.dataDir });
			await expect(
				h.engine.create(
					makeSpec(h, "run_e4", {
						hostClonePathHint: join(h.dataDir, "not-a-repo"),
						originUrl: "",
					}),
				),
			).rejects.toThrow();
			expect(existsSync(localWorkspacePath(roots, "local-run_e4"))).toBe(false);
			expect(existsSync(localHomePath(roots, "local-run_e4"))).toBe(false);
		} finally {
			await h.cleanup();
		}
	});
});

describe("LocalEngine.streamEvents", () => {
	test("replays and live-follows the store until terminal, honoring sinceSeq", async () => {
		const h = await makeHarness();
		try {
			const handle = await h.engine.create(makeSpec(h, "run_e5"));
			const seen: number[] = [];
			for await (const event of h.engine.streamEvents(handle)) {
				seen.push(event.seq);
				expect(event.origin).toBe("warren");
			}
			expect(seen.length).toBeGreaterThan(0);
			// monotonic from 1
			expect(seen[0]).toBe(1);
			// sinceSeq dedups the replay
			const tail: number[] = [];
			for await (const event of h.engine.streamEvents(handle, { sinceSeq: 1 })) {
				tail.push(event.seq);
			}
			expect(tail.every((s) => s > 1)).toBe(true);
		} finally {
			await h.cleanup();
		}
	});

	test("throws RuntimeRunNotFoundError for a ghost run", async () => {
		const h = await makeHarness();
		try {
			const stream = h.engine.streamEvents({
				runId: "ghost",
				sandboxId: "local-ghost",
				providerRunId: "ghost",
			});
			await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(RuntimeRunNotFoundError);
		} finally {
			await h.cleanup();
		}
	});
});

describe("LocalEngine.status", () => {
	test("returns exists:false + lost for a missing run", async () => {
		const h = await makeHarness();
		try {
			const status = await h.engine.status({
				runId: "ghost",
				sandboxId: "local-ghost",
				providerRunId: "ghost",
			});
			expect(status.exists).toBe(false);
			expect(status.terminalReason).toBe("lost");
			expect(status.lastEventSeq).toBe(0);
		} finally {
			await h.cleanup();
		}
	});
});

describe("LocalEngine.sendMessage + cancel", () => {
	test("sendMessage persists a row with burrow's defaults", async () => {
		const h = await makeHarness();
		try {
			const handle = await h.engine.create(makeSpec(h, "run_e6"));
			const message = await h.engine.sendMessage(handle, { body: "steer" });
			expect(message.priority).toBe("normal");
			expect(message.fromActor).toBe("user");
			expect(message.state).toBe("unread");
			expect(message.runId).toBeNull();
		} finally {
			await h.cleanup();
		}
	});

	test("sendMessage on a ghost sandbox throws RuntimeRunNotFoundError", async () => {
		const h = await makeHarness();
		try {
			await expect(
				h.engine.sendMessage(
					{ runId: "ghost", sandboxId: "local-ghost", providerRunId: "ghost" },
					{ body: "x" },
				),
			).rejects.toThrow(RuntimeRunNotFoundError);
		} finally {
			await h.cleanup();
		}
	});

	test("cancel on a ghost run rejects; on a terminal run resolves", async () => {
		const h = await makeHarness();
		try {
			await expect(
				h.engine.cancel({ runId: "ghost", sandboxId: "local-ghost", providerRunId: "ghost" }),
			).rejects.toThrow(RuntimeRunNotFoundError);
			const handle = await h.engine.create(makeSpec(h, "run_e7"));
			await awaitTerminal(h.engine, handle.providerRunId);
			await h.engine.cancel(handle, "done");
		} finally {
			await h.cleanup();
		}
	});

	// warren-8a6e: cancel must surface phase=cancelled on status() immediately
	// so cancelRun's inline-reap path fires without the 30s watchdog tick.
	test("cancel terminalizes the record immediately for status()", async () => {
		const h = await makeHarness();
		try {
			let release: (() => void) | undefined;
			const held = new Promise<void>((r) => {
				release = r;
			});
			let cancelCount = 0;
			const empty = new ReadableStream<Uint8Array>({
				start(c) {
					c.close();
				},
			});
			const longProc = (): SpawnResult => ({
				pid: 9999,
				stdout: new ReadableStream({ start() {} }),
				stderr: empty,
				exited: held.then(() => 143),
				cancel: () => {
					cancelCount += 1;
					release?.();
				},
				closeStdin: () => Promise.resolve(),
				writeStdin: () => Promise.resolve(),
			});
			const engine = new LocalEngine({
				serverEnv: { WARREN_DATA_DIR: h.dataDir },
				store: h.store,
				drive: {
					registry: { get: (id: string) => (id === "fake" ? fakeAdapter : undefined) } as never,
					spawn: async () => longProc(),
				},
			});
			const handle = await engine.create(makeSpec(h, "run_e7_cancel"));
			for (let i = 0; i < 50; i++) {
				if ((await engine.status(handle)).phase === "running") break;
				await Bun.sleep(20);
			}
			await engine.cancel(handle, "operator stop");
			const status = await engine.status(handle);
			expect(status.phase).toBe("cancelled");
			expect(status.terminalReason).toBe("cancelled");
			expect(status.exists).toBe(true);
			expect(cancelCount).toBeGreaterThanOrEqual(1);
		} finally {
			await h.cleanup();
		}
	});
});

describe("LocalEngine.workspaceInfo + finalize + terminate", () => {
	test("workspaceInfo resolves the live record and falls back to the manifest", async () => {
		const h = await makeHarness();
		try {
			const handle = await h.engine.create(makeSpec(h, "run_e8"));
			await awaitTerminal(h.engine, handle.providerRunId);
			const info = await h.engine.workspaceInfo(handle);
			expect(info.branch).toBe("warren/run_e8");
			expect(info.workspacePath).toContain("local-run_e8");
		} finally {
			await h.cleanup();
		}
	});

	test("workspaceInfo throws for a run neither store nor manifest knows", async () => {
		const h = await makeHarness();
		try {
			await expect(
				h.engine.workspaceInfo({
					runId: "ghost",
					sandboxId: "local-ghost",
					providerRunId: "ghost",
				}),
			).rejects.toThrow(RuntimeProviderError);
		} finally {
			await h.cleanup();
		}
	});

	test("finalize runs the no-artifact pipeline against the record's workspace", async () => {
		const h = await makeHarness();
		try {
			const handle = await h.engine.create(makeSpec(h, "run_e9"));
			await awaitTerminal(h.engine, handle.providerRunId);
			const result = await h.engine.finalize(handle, {
				branch: "warren/run_e9",
				push: false,
				artifacts: [],
			});
			expect(result.pushed).toBe(false);
			expect(result.stages.every((s) => s.status === "skipped")).toBe(true);
		} finally {
			await h.cleanup();
		}
	});

	test("stores the sandbox profile on the record and cascades sidecar teardown", async () => {
		const h = await makeHarness();
		const cascaded: string[] = [];
		const engine = new LocalEngine({
			serverEnv: { WARREN_DATA_DIR: h.dataDir, WARREN_BIND_PORT: "8181" },
			store: h.store,
			drive: {
				spawn: () => Promise.resolve(immediateProc([TERMINAL_LINE])),
				registry: { get: (id) => (id === "fake" ? fakeAdapter : undefined) },
			},
			sidecars: {
				cascadeDelete: (sandboxId) => {
					cascaded.push(sandboxId);
					return Promise.resolve();
				},
			},
		});
		try {
			const handle = await engine.create(makeSpec(h, "run_e11"));
			await awaitTerminal(engine, handle.providerRunId);
			const record = h.store.getBySandboxId(handle.sandboxId);
			expect(record).toBeDefined();
			expect(record?.profile).not.toBeNull();
			expect(record?.profile?.workspace).toContain("local-run_e11");
			await engine.terminate(handle);
			expect(cascaded).toEqual([handle.sandboxId]);
		} finally {
			await h.cleanup();
		}
	});

	test("terminate reclaims the workspace, HOME, and manifest; idempotent", async () => {
		const h = await makeHarness();
		try {
			const handle = await h.engine.create(makeSpec(h, "run_e10"));
			await awaitTerminal(h.engine, handle.providerRunId);
			const roots = resolveLocalStateRoots({ WARREN_DATA_DIR: h.dataDir });
			const result = await h.engine.terminate(handle);
			expect(result.deletedRuns).toBe(1);
			expect(result.deletedEvents).toBeGreaterThan(0);
			expect(result.archived).toBe(false);
			expect(existsSync(localWorkspacePath(roots, handle.sandboxId))).toBe(false);
			expect(existsSync(localHomePath(roots, handle.sandboxId))).toBe(false);
			expect(await readLocalRunManifest(roots, handle.sandboxId)).toBeNull();
			// idempotent: the second call reclaims nothing
			const again = await h.engine.terminate(handle);
			expect(again.deletedRuns).toBe(0);
			expect(again.deletedEvents).toBe(0);
		} finally {
			await h.cleanup();
		}
	});
});
