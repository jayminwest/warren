import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "../../sandbox/types.ts";
import { DOCKER_AGENT_GID, DOCKER_AGENT_UID } from "./container-spec.ts";
import { chownDockerMounts, chownPathRecursive, makeDockerSpawn } from "./spawn.ts";

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

describe("chownDockerMounts", () => {
	test("chowns workspace, home, and gitdir when chownMounts is set", () => {
		const seen: Array<{ path: string; uid: number; gid: number }> = [];
		chownDockerMounts(
			makeProfile({ workspaceGitdir: "/repo/.git" }),
			{ uid: 1000, gid: 1000, chownMounts: true },
			(path, uid, gid) => {
				seen.push({ path, uid, gid });
			},
		);
		expect(seen).toEqual([
			{ path: "/data/local/workspaces/local-run-9", uid: 1000, gid: 1000 },
			{ path: "/data/local/homes/local-run-9", uid: 1000, gid: 1000 },
			{ path: "/repo/.git", uid: 1000, gid: 1000 },
		]);
	});

	test("skips chown when the agent runs as the host user", () => {
		const seen: string[] = [];
		chownDockerMounts(makeProfile(), { uid: 501, gid: 20, chownMounts: false }, (path) => {
			seen.push(path);
		});
		expect(seen).toEqual([]);
	});

	test("chownPathRecursive visits every nested path (chown-to-self is a no-op)", () => {
		const root = mkdtempSync(join(tmpdir(), "warren-chown-"));
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "f.txt"), "x");
		const uid = typeof process.getuid === "function" ? process.getuid() : 0;
		const gid = typeof process.getgid === "function" ? process.getgid() : 0;
		// chown to the calling uid is permitted without CAP_CHOWN and exercises
		// the recursive walk end-to-end under any host identity.
		expect(() => chownPathRecursive(root, uid, gid)).not.toThrow();
	});
});

describe("makeDockerSpawn", () => {
	test("spawns docker run with the container argv and writes the env file", async () => {
		const procs: FakeProc[] = [];
		const chowned: Array<{ path: string; uid: number; gid: number }> = [];
		const spawn = makeDockerSpawn({
			tmpRoot: tmpRoot(),
			hostIdentity: { uid: 0, gid: 0 },
			chownPath: (path, uid, gid) => {
				chowned.push({ path, uid, gid });
			},
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
		expect(run?.argv[run.argv.indexOf("--user") + 1]).toBe(
			`${DOCKER_AGENT_UID}:${DOCKER_AGENT_GID}`,
		);
		expect(run?.argv.at(-1)).toBe("--print");
		expect(chowned).toEqual([
			{ path: "/data/local/workspaces/local-run-9", uid: 1000, gid: 1000 },
			{ path: "/data/local/homes/local-run-9", uid: 1000, gid: 1000 },
		]);
		procs[0]?.resolveExit(0);
		expect(await result.exited).toBe(0);
	});

	test("non-root host identity skips chown and passes that uid as --user", async () => {
		const procs: FakeProc[] = [];
		const chowned: string[] = [];
		const spawn = makeDockerSpawn({
			tmpRoot: tmpRoot(),
			hostIdentity: { uid: 501, gid: 20 },
			chownPath: (path) => {
				chowned.push(path);
			},
			spawn: (argv) => {
				const proc = makeFakeProc(argv);
				procs.push(proc);
				return proc.subprocess;
			},
			runDocker: () => Promise.resolve({ exitCode: 0, stdout: "false" }),
		});
		await spawn(makeProfile(), { argv: ["claude"] });
		expect(procs[0]?.argv[procs[0].argv.indexOf("--user") + 1]).toBe("501:20");
		expect(chowned).toEqual([]);
		procs[0]?.resolveExit(0);
	});

	test("resolves exited with the container exit code and probes OOMKilled", async () => {
		const procs: FakeProc[] = [];
		const inspected: string[][] = [];
		const spawn = makeDockerSpawn({
			tmpRoot: tmpRoot(),
			hostIdentity: { uid: 501, gid: 20 },
			chownPath: () => {},
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
			hostIdentity: { uid: 501, gid: 20 },
			chownPath: () => {},
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
			hostIdentity: { uid: 501, gid: 20 },
			chownPath: () => {},
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
			hostIdentity: { uid: 501, gid: 20 },
			chownPath: () => {},
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
