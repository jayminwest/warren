import { describe, expect, test } from "bun:test";
import { buildSeatbeltArgv, buildSeatbeltProfile, SYSTEM_READ_SUBPATHS } from "./seatbelt.ts";
import type { SandboxProfile } from "./types.ts";

function baseProfile(over: Partial<SandboxProfile> = {}): SandboxProfile {
	return {
		workspace: "/Users/u/ws",
		home: "/Users/u/homes/run-1",
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
		...over,
	};
}

describe("buildSeatbeltProfile", () => {
	test("starts with version + deny-default", () => {
		const out = buildSeatbeltProfile(baseProfile());
		expect(out).toContain("(version 1)");
		expect(out).toContain("(deny default)");
	});

	test("system subpaths are allowed read", () => {
		const out = buildSeatbeltProfile(baseProfile());
		for (const path of SYSTEM_READ_SUBPATHS) {
			expect(out).toContain(`(allow file-read* (subpath "${path}"))`);
		}
	});

	test("workspace is allowed read+write", () => {
		const out = buildSeatbeltProfile(baseProfile({ workspace: "/Users/u/ws" }));
		expect(out).toContain('(subpath "/Users/u/ws")');
		expect(out).toMatch(/file-write\*.*\(subpath "\/Users\/u\/ws"\)/);
	});

	test("home is allowed read+write, separate from the workspace (warren-c865)", () => {
		const out = buildSeatbeltProfile(baseProfile({ home: "/Users/u/homes/run-1" }));
		expect(out).toContain(
			'(allow file-read-data file-read-metadata file-write* (subpath "/Users/u/homes/run-1"))',
		);
	});

	test("network=open allows network*", () => {
		const out = buildSeatbeltProfile(baseProfile({ network: "open" }));
		expect(out).toContain("(allow network*)");
	});

	test("network=none emits no network rule", () => {
		const out = buildSeatbeltProfile(baseProfile({ network: "none" }));
		expect(out).not.toMatch(/allow network/);
	});

	test("network=restricted with proxyAddress allows loopback to the proxy port", () => {
		const out = buildSeatbeltProfile(
			baseProfile({
				network: "restricted",
				allowedDomains: ["registry.npmjs.org", "github.com"],
				proxyAddress: { host: "127.0.0.1", port: 51234 },
			}),
		);
		// sandbox-exec's `remote tcp` only accepts `localhost`/`*` as the
		// host token; numeric IPs raise a parse error. The host-side proxy
		// enforces the domain allowlist behind that loopback endpoint.
		expect(out).toContain('(allow network-outbound (remote tcp "localhost:51234"))');
		expect(out).not.toMatch(/127\.0\.0\.1:51234/);
		// Domain rules are no longer in the profile (sandbox-exec can't
		// match by hostname after DNS — see burrow-14b6).
		expect(out).not.toMatch(/regex/);
		expect(out).not.toContain("mDNSResponder");
	});

	test("network=restricted without proxyAddress denies all outbound", () => {
		const out = buildSeatbeltProfile(
			baseProfile({
				network: "restricted",
				allowedDomains: ["github.com"],
			}),
		);
		// Without a proxy endpoint the profile emits no allow rules and
		// falls back to the global deny — explicit, honest, and safer than
		// the legacy hostname regex which silently denied everything anyway.
		expect(out).not.toMatch(/allow network/);
	});

	test("sshAuthSock literal allow is rendered", () => {
		const out = buildSeatbeltProfile(baseProfile({ sshAuthSock: "/tmp/ssh-agent.sock" }));
		expect(out).toContain('(literal "/tmp/ssh-agent.sock")');
	});

	test("toolchain + extra readOnlyMounts are allowed read", () => {
		const out = buildSeatbeltProfile(
			baseProfile({
				toolchainPaths: ["/opt/homebrew/bin/bun"],
				readOnlyMounts: ["/Users/u/.cargo"],
			}),
		);
		expect(out).toContain('(allow file-read* (subpath "/opt/homebrew/bin/bun"))');
		expect(out).toContain('(allow file-read* (subpath "/Users/u/.cargo"))');
	});

	test("bun global install root is allowed read when in toolchainPaths (burrow-aa46)", () => {
		// `up` adds `<BUN_INSTALL>/install/global/node_modules` to toolchainPaths
		// when bun is a declared toolchain so the bun-shebang stubs under
		// `<BUN_INSTALL>/bin/` (ml, sd, cn …) can resolve their .ts source.
		const out = buildSeatbeltProfile(
			baseProfile({
				toolchainPaths: ["/Users/u/.bun/bin", "/Users/u/.bun/install/global/node_modules"],
			}),
		);
		expect(out).toContain(
			'(allow file-read* (subpath "/Users/u/.bun/install/global/node_modules"))',
		);
	});

	test("temp roots get read+write so claude-code's Bash output round-trip works (burrow-8452)", () => {
		const out = buildSeatbeltProfile(baseProfile());
		expect(out).toContain('(allow file-read* file-write* (subpath "/private/tmp"))');
		expect(out).toContain('(allow file-read* file-write* (subpath "/private/var/folders"))');
	});

	test("/dev/null is writable so shell redirects don't ENOENT (burrow-8452)", () => {
		const out = buildSeatbeltProfile(baseProfile());
		expect(out).toContain('(allow file-write* (literal "/dev/null"))');
	});

	test("workspaceGitdir gets read+write subpath rule (burrow-7a80)", () => {
		// Worktree-backed workspaces carry a `.git` *file* whose `gitdir:` points
		// at `<hostClonePath>/.git/worktrees/<id>`, outside the workspace subpath.
		// The agent needs read+write on the host's git common dir at the same
		// path so `git commit`/`git push` can update per-worktree HEAD/index and
		// write new objects to the shared object database.
		const out = buildSeatbeltProfile(baseProfile({ workspaceGitdir: "/Users/u/clone/.git" }));
		expect(out).toContain(
			'(allow file-read-data file-read-metadata file-write* (subpath "/Users/u/clone/.git"))',
		);
	});

	test("workspaceGitdir rule is omitted when unset (clone-backed workspaces)", () => {
		const out = buildSeatbeltProfile(baseProfile());
		expect(out).not.toMatch(/\.git/);
	});

	test("paths with double-quotes are escaped", () => {
		const out = buildSeatbeltProfile(baseProfile({ workspace: '/tmp/ws"weird' }));
		expect(out).toContain('"/tmp/ws\\"weird"');
	});
});

describe("buildSeatbeltArgv", () => {
	test("invokes sandbox-exec -f <profile> then the user argv", () => {
		const argv = buildSeatbeltArgv("/tmp/p.sb", { argv: ["echo", "hi"] });
		expect(argv).toEqual(["sandbox-exec", "-f", "/tmp/p.sb", "echo", "hi"]);
	});

	test("sandboxExecBin override is honored", () => {
		const argv = buildSeatbeltArgv("/tmp/p.sb", { argv: ["true"] }, { sandboxExecBin: "/opt/sb" });
		expect(argv[0]).toBe("/opt/sb");
	});
});
