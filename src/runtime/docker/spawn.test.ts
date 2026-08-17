import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "../../sandbox/types.ts";
import { makeDockerSpawn } from "./spawn.ts";

function makeProfile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
	return {
		workspace: "/data/local/workspaces/local-run-9",
		home: "/data/local/homes/local-run-9",
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: { WARREN_API_TOKEN: "secret" },
		toolchainPaths: [],
		...overrides,
	};
}

interface FakeProc {
	readonly argv: string[];
	readonly written: string[];
	stdinClosed: boolean;
	killed: boolean;
	resolveExit: (code: number) => void;
	subprocess: Bun.Subprocess;
}

function makeFakeProc(argv: string[]): FakeProc {
	const written: string[] = [];
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const fake: FakeProc = {
		argv,
		written,
		stdinClosed: false,
		killed: false,
		resolveExit,
		subprocess: undefined as unknown as Bun.Subprocess,
	};
	const sink = {
		write: (chunk: Uint8Array) => {
			written.push(new TextDecoder().decode(chunk));
			return chunk.length;
		},
		flush: () => Promise.resolve(),
		end: () => {
			fake.stdinClosed = true;
			return Promise.resolve();
		},
	};
	fake.subprocess = {
		pid: 4242,
		stdin: sink,
		stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
		stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
		exited,
		kill: () => {
			fake.killed = true;
		},
	} as unknown as Bun.Subprocess;
	return fake;
}

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "warren-docker-spawn-test-"));
}

describe("makeDockerSpawn", () => {
	test("spawns docker run with the container argv and writes the env file", async () => {
		const procs: FakeProc[] = [];
		const spawn = makeDockerSpawn({
			tmpRoot: tmpRoot(),
			spawn: (argv) => {
				const proc = makeFakeProc(argv);
				procs.push(proc);
				return proc.subprocess;
			},
			runDocker: () => Promise.resolve({ exitCode: 0, stdout: "false" }),
		});
		const result = await spawn(makeProfile(), { argv: ["claude", "--print"] });
		const run = procs[0];
		expect(run).toBeDefined();
		expect(run?.argv[1]).toBe("run");
		expect(run?.argv).toContain("warren-run-local-run-9");
		expect(run?.argv.at(-1)).toBe("--print");
		procs[0]?.resolveExit(0);
		expect(await result.exited).toBe(0);
	});

	test("resolves exited with the container exit code and probes OOMKilled", async () => {
		const procs: FakeProc[] = [];
		const inspected: string[][] = [];
		const spawn = makeDockerSpawn({
			tmpRoot: tmpRoot(),
			spawn: (argv) => {
				const proc = makeFakeProc(argv);
				procs.push(proc);
				return proc.subprocess;
			},
			runDocker: (argv) => {
				inspected.push(argv);
				return Promise.resolve({ exitCode: 0, stdout: argv[1] === "inspect" ? "true" : "" });
			},
		});
		const result = await spawn(makeProfile(), { argv: ["claude"] });
		procs[0]?.resolveExit(137);
		expect(await result.exited).toBe(137);
		expect(result.oomKilled?.()).toBe(true);
		expect(inspected.some((a) => a[1] === "inspect" && a.includes("warren-run-local-run-9"))).toBe(
			true,
		);
		expect(inspected.some((a) => a[1] === "rm" && a.includes("warren-run-local-run-9"))).toBe(true);
	});

	test("writes a string stdin then closes it for batch commands", async () => {
		const procs: FakeProc[] = [];
		const spawn = makeDockerSpawn({
			tmpRoot: tmpRoot(),
			spawn: (argv) => {
				const proc = makeFakeProc(argv);
				procs.push(proc);
				return proc.subprocess;
			},
			runDocker: () => Promise.resolve({ exitCode: 0, stdout: "" }),
		});
		await spawn(makeProfile(), { argv: ["claude"], stdin: "the prompt" });
		expect(procs[0]?.written.join("")).toBe("the prompt");
		expect(procs[0]?.stdinClosed).toBe(true);
	});

	test("holds stdin open for holdStdin commands until closeStdin", async () => {
		const procs: FakeProc[] = [];
		const spawn = makeDockerSpawn({
			tmpRoot: tmpRoot(),
			spawn: (argv) => {
				const proc = makeFakeProc(argv);
				procs.push(proc);
				return proc.subprocess;
			},
			runDocker: () => Promise.resolve({ exitCode: 0, stdout: "" }),
		});
		const result = await spawn(makeProfile(), {
			argv: ["pi"],
			stdin: "payload",
			holdStdin: true,
		});
		expect(procs[0]?.stdinClosed).toBe(false);
		await result.writeStdin?.("more");
		expect(procs[0]?.written.join("")).toBe("payloadmore");
		await result.closeStdin?.();
		expect(procs[0]?.stdinClosed).toBe(true);
	});

	test("cancel kills the CLI child and force-removes the container", async () => {
		const procs: FakeProc[] = [];
		const calls: string[][] = [];
		const spawn = makeDockerSpawn({
			tmpRoot: tmpRoot(),
			spawn: (argv) => {
				const proc = makeFakeProc(argv);
				procs.push(proc);
				return proc.subprocess;
			},
			runDocker: (argv) => {
				calls.push(argv);
				return Promise.resolve({ exitCode: 0, stdout: "" });
			},
		});
		const result = await spawn(makeProfile(), { argv: ["claude"] });
		result.cancel();
		expect(procs[0]?.killed).toBe(true);
		expect(calls.some((a) => a[1] === "rm" && a[2] === "-f")).toBe(true);
	});
});
