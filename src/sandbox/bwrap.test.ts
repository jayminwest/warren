import { describe, expect, test } from "bun:test";
import {
	buildBwrapArgv,
	DEFAULT_SANDBOX_GID,
	DEFAULT_SANDBOX_UID,
	SANDBOX_HOME_PATH,
	SYSTEM_RO_MOUNTS,
} from "./bwrap.ts";
import type { SandboxProfile, SpawnCommand } from "./types.ts";

function baseProfile(over: Partial<SandboxProfile> = {}): SandboxProfile {
	return {
		workspace: "/host/workspaces/bur_x",
		home: "/host/homes/bur_x",
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
		...over,
	};
}

const cmd = (over: Partial<SpawnCommand> = {}): SpawnCommand => ({
	argv: ["echo", "hi"],
	...over,
});

describe("buildBwrapArgv", () => {
	test("starts with `bwrap --unshare-all`, ends with `-- argv`", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd());
		expect(argv[0]).toBe("bwrap");
		expect(argv).toContain("--unshare-all");
		const dashDash = argv.indexOf("--");
		expect(dashDash).toBeGreaterThan(0);
		expect(argv.slice(dashDash + 1)).toEqual(["echo", "hi"]);
	});

	test("network=open shares the host net namespace", () => {
		const argv = buildBwrapArgv(baseProfile({ network: "open" }), cmd());
		expect(argv).toContain("--share-net");
	});

	test("network=none keeps net unshared; network=restricted needs proxyAddress to share-net", () => {
		const none = buildBwrapArgv(baseProfile({ network: "none" }), cmd());
		const restrictedNoProxy = buildBwrapArgv(
			baseProfile({ network: "restricted", allowedDomains: ["github.com"] }),
			cmd(),
		);
		const restrictedWithProxy = buildBwrapArgv(
			baseProfile({
				network: "restricted",
				allowedDomains: ["github.com"],
				proxyAddress: { host: "127.0.0.1", port: 51234 },
			}),
			cmd(),
		);
		expect(none).not.toContain("--share-net");
		// Restricted without a proxy stays deny-all (broken legacy behavior is
		// surfaced explicitly: callers can declare intent today).
		expect(restrictedNoProxy).not.toContain("--share-net");
		// Restricted + proxy shares the host net so the agent can reach the
		// loopback proxy that enforces the domain allowlist.
		expect(restrictedWithProxy).toContain("--share-net");
	});

	test("workspace is bound read-write at /workspace", () => {
		const argv = buildBwrapArgv(baseProfile({ workspace: "/host/ws" }), cmd());
		expectAdjacent(argv, "--bind", "/host/ws", "/workspace");
	});

	test("home is bound read-write at SANDBOX_HOME_PATH, separate from the workspace (warren-c865)", () => {
		const argv = buildBwrapArgv(baseProfile({ home: "/host/homes/run-1" }), cmd());
		expectAdjacent(argv, "--bind", "/host/homes/run-1", SANDBOX_HOME_PATH);
		expect(SANDBOX_HOME_PATH).not.toBe("/workspace");
		// The home bind precedes the workspace bind so a nested host layout
		// can never shadow it.
		const homeIdx = argv.indexOf("/host/homes/run-1");
		const wsIdx = argv.indexOf("/workspace");
		expect(homeIdx).toBeGreaterThanOrEqual(0);
		expect(wsIdx).toBeGreaterThan(homeIdx);
	});

	test("system dirs are bound read-only via --ro-bind-try", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd());
		for (const path of SYSTEM_RO_MOUNTS) {
			expectAdjacent(argv, "--ro-bind-try", path, path);
		}
	});

	test("toolchain and ssh agent paths get hard --ro-bind", () => {
		const argv = buildBwrapArgv(
			baseProfile({
				toolchainPaths: ["/opt/homebrew/bin/bun"],
				sshAuthSock: "/run/user/1000/ssh-agent",
			}),
			cmd(),
		);
		expectAdjacent(argv, "--ro-bind", "/opt/homebrew/bin/bun", "/opt/homebrew/bin/bun");
		expectAdjacent(argv, "--ro-bind", "/run/user/1000/ssh-agent", "/run/user/1000/ssh-agent");
	});

	test("bun global install root mounts when present in toolchainPaths (burrow-aa46)", () => {
		// `up` adds `<BUN_INSTALL>/install/global/node_modules` to toolchainPaths
		// when bun is a declared toolchain so symlinked CLIs (ml, sd, cn …) can
		// load their .ts source from inside the sandbox.
		const argv = buildBwrapArgv(
			baseProfile({
				toolchainPaths: ["/home/u/.bun/bin", "/home/u/.bun/install/global/node_modules"],
			}),
			cmd(),
		);
		expectAdjacent(
			argv,
			"--ro-bind",
			"/home/u/.bun/install/global/node_modules",
			"/home/u/.bun/install/global/node_modules",
		);
	});

	test("env is NOT placed on argv: secrets stay out of /proc/<pid>/cmdline (burrow-ab95)", () => {
		// Regression for burrow-ab95. Env values like ANTHROPIC_API_KEY used to land
		// on argv via `--setenv NAME VALUE` and leak through /proc/<pid>/cmdline
		// (world-readable). They now travel via the bwrap process env (set by
		// spawnLinux's Bun.spawn), so neither the names of envPassthrough/setEnv
		// keys nor their values appear in argv. Verified separately: the resolved
		// env still reaches the child — see env.test.ts and the macOS integration
		// tests in sandbox.test.ts.
		const argv = buildBwrapArgv(
			baseProfile({
				envPassthrough: ["ANTHROPIC_API_KEY"],
				setEnv: { OPENAI_API_KEY: "sk-secret-from-setenv", LOG_LEVEL: "debug" },
				sshAuthSock: "/tmp/agent.sock",
			}),
			cmd({ env: { GITHUB_TOKEN: "ghp_secret-from-cmd" } }),
		);
		expect(argv).not.toContain("--clearenv");
		expect(argv).not.toContain("--setenv");
		// Concrete secret values must not appear anywhere on the argv.
		expect(argv).not.toContain("sk-secret-from-setenv");
		expect(argv).not.toContain("ghp_secret-from-cmd");
		// Sanity: the workspace bind, ssh-agent ro-bind, and child argv are all
		// still emitted — env stripping didn't accidentally take them with it.
		expectAdjacent(argv, "--bind", "/host/workspaces/bur_x", "/workspace");
		expectAdjacent(argv, "--ro-bind", "/tmp/agent.sock", "/tmp/agent.sock");
		const dashDash = argv.indexOf("--");
		expect(argv.slice(dashDash + 1)).toEqual(["echo", "hi"]);
	});

	test("workspaceGitdir is bound read-write at the same host path (burrow-7a80)", () => {
		// Worktree-backed workspaces carry a `.git` *file* whose `gitdir:` points
		// at `<hostClonePath>/.git/worktrees/<id>`. The /workspace bind doesn't
		// reach that path, so without this mount every git invocation inside the
		// sandbox fails with `fatal: not a git repository`.
		const argv = buildBwrapArgv(
			baseProfile({
				workspace: "/host/ws",
				workspaceGitdir: "/host/clone/.git",
			}),
			cmd(),
		);
		expectAdjacent(argv, "--bind", "/host/clone/.git", "/host/clone/.git");
		// The workspace bind must still be present (and downstream of the gitdir
		// bind so `/workspace` doesn't shadow anything).
		expectAdjacent(argv, "--bind", "/host/ws", "/workspace");
	});

	test("workspaceGitdir is omitted entirely when not set (clone-backed workspaces)", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd());
		// Only the home + workspace binds should be present — no extra --bind pairs.
		const bindIndices = argv.reduce<number[]>(
			(acc, tok, i) => (tok === "--bind" ? acc.concat(i) : acc),
			[],
		);
		expect(bindIndices.length).toBe(2);
	});

	test("--die-with-parent and --chdir /workspace are present", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd());
		expect(argv).toContain("--die-with-parent");
		expectAdjacent(argv, "--chdir", "/workspace");
	});

	test("defaults to non-root --uid/--gid so claude-code etc. don't refuse on root hosts (burrow-0329)", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd());
		expectAdjacent(argv, "--uid", String(DEFAULT_SANDBOX_UID));
		expectAdjacent(argv, "--gid", String(DEFAULT_SANDBOX_GID));
		expect(DEFAULT_SANDBOX_UID).not.toBe(0);
		expect(DEFAULT_SANDBOX_GID).not.toBe(0);
	});

	test("profile.runAsUid/runAsGid override the defaults", () => {
		const argv = buildBwrapArgv(baseProfile({ runAsUid: 1500, runAsGid: 1501 }), cmd());
		expectAdjacent(argv, "--uid", "1500");
		expectAdjacent(argv, "--gid", "1501");
		expect(argv).not.toContain(String(DEFAULT_SANDBOX_UID));
	});

	test("--uid/--gid emitted after --unshare-all (bwrap requires userns first)", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd());
		const unshareIdx = argv.indexOf("--unshare-all");
		const uidIdx = argv.indexOf("--uid");
		const gidIdx = argv.indexOf("--gid");
		expect(unshareIdx).toBeGreaterThanOrEqual(0);
		expect(uidIdx).toBeGreaterThan(unshareIdx);
		expect(gidIdx).toBeGreaterThan(unshareIdx);
	});

	test("relative cwd resolves under /workspace", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd({ cwd: "src" }));
		expectAdjacent(argv, "--chdir", "/workspace/src");
	});

	test("absolute cwd is preserved", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd({ cwd: "/workspace/sub" }));
		expectAdjacent(argv, "--chdir", "/workspace/sub");
	});
});

function expectAdjacent(argv: string[], ...tokens: string[]): void {
	for (let i = 0; i + tokens.length <= argv.length; i++) {
		let ok = true;
		for (let j = 0; j < tokens.length; j++) {
			if (argv[i + j] !== tokens[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return;
	}
	throw new Error(
		`expected adjacent tokens ${JSON.stringify(tokens)} in argv:\n${JSON.stringify(argv, null, 2)}`,
	);
}
