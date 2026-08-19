/**
 * warren-8a6e: LocalEngine.cancel terminalizes immediately; the drive loop
 * must not overwrite a settled cancelled phase with a kill-exit failure.
 */
import { describe, expect, test } from "bun:test";
import type { SandboxProfile, SpawnResult } from "../../sandbox/types.ts";
import type { AgentRuntimeAdapter } from "../adapters/index.ts";
import type { RunSpec } from "../contract.ts";
import { driveLocalRun } from "./drive.ts";
import { LocalRunStore } from "./run-store.ts";

const PROFILE: SandboxProfile = {
	workspace: "/tmp/ws",
	home: "/tmp/home",
	readOnlyMounts: [],
	network: "open",
	allowedDomains: [],
	envPassthrough: [],
	setEnv: {},
	toolchainPaths: [],
};

function makeFakeProc(exitCode = 143): { proc: SpawnResult; cancel: () => void } {
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
	const stdout = new ReadableStream<Uint8Array>({
		start(ctrl) {
			stdoutCtrl = ctrl;
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(ctrl) {
			ctrl.close();
		},
	});
	const finish = (): void => {
		stdoutCtrl.close();
		resolveExit(exitCode);
	};
	return {
		proc: {
			pid: 4242,
			stdout,
			stderr,
			exited,
			cancel: finish,
			closeStdin: () => Promise.resolve(),
			writeStdin: () => Promise.resolve(),
		},
		cancel: finish,
	};
}

const adapter = {
	runtimeId: "fake",
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: () => ({ argv: ["fake"], stdin: "do it" }),
	parseEvents: () => [],
} as unknown as AgentRuntimeAdapter;

const spec: RunSpec = {
	runId: "run_cancel1",
	originUrl: "https://github.com/o/r.git",
	branch: "warren/run_cancel1",
	baseBranch: "main",
	hostClonePathHint: "/data/projects/x/y",
	runtimeId: "fake",
	prompt: "do it",
	mode: "batch",
	network: "open",
	seedFiles: [],
	env: {},
};

describe("driveLocalRun cancel settle", () => {
	test("leaves an already-terminal cancelled record alone after pump drain", async () => {
		const store = new LocalRunStore();
		const record = store.create({
			runId: "run_cancel1",
			sandboxId: "local-run_cancel1",
			workspacePath: "/tmp/ws",
			homePath: "/tmp/home",
			branch: "warren/run_cancel1",
		});
		const fake = makeFakeProc(143);
		await driveLocalRun(store, record, spec, PROFILE, {
			spawn: async () => {
				queueMicrotask(() => {
					record.cancelRequested = true;
					store.terminalize(record, {
						phase: "cancelled",
						exitCode: null,
						terminalReason: "cancelled",
						errorMessage: "cancelled",
					});
					fake.cancel();
				});
				return fake.proc;
			},
			registry: { get: (id) => (id === "fake" ? adapter : undefined) },
		});
		expect(record.phase).toBe("cancelled");
		expect(record.terminalReason).toBe("cancelled");
		expect(record.exitCode).toBeNull();
	});
});
