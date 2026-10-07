import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import {
	buildSeatbeltArgv,
	buildSeatbeltProfile,
	resolveHostBunInstall,
	SYSTEM_READ_SUBPATHS,
	xcodeBundleContents,
} from "./seatbelt.ts";
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

	test("host bun install root is always readable (warren-bea7)", () => {
		// bun's `bun run` path and bun-shebang CLIs resolve the real user's
		// ~/.bun via getpwuid, not $HOME. Grant only that install root — never
		// the whole host home — so quality gates and sd/ml work in-sandbox.
		const out = buildSeatbeltProfile(baseProfile());
		// Profile canonicalizes the path the same way sandbox.ts does for other
		// binds (seatbelt matches realpath forms).
		const raw = resolveHostBunInstall();
		let bunInstall = raw;
		try {
			bunInstall = realpathSync(raw);
		} catch {
			// missing install root still renders the unresolved path
		}
		expect(out).toContain(`(allow file-read* (subpath "${bunInstall}"))`);
		// Must not open the whole host home as a subpath grant.
		const hostHome = bunInstall.endsWith("/.bun") ? bunInstall.slice(0, -"/.bun".length) : null;
		if (hostHome !== null && hostHome.length > 1) {
			expect(out).not.toContain(`(allow file-read* (subpath "${hostHome}"))`);
		}
	});

	test("Xcode developer dir grants read on the bundle Contents only (warren-11e6)", () => {
		const out = buildSeatbeltProfile(baseProfile(), {
			developerDir: "/nonexistent/Xcode.app/Contents/Developer",
		});
		expect(out).toContain('(allow file-read* (subpath "/nonexistent/Xcode.app/Contents"))');
		expect(out).not.toContain('(subpath "/nonexistent")');
		expect(out).not.toContain('(subpath "/nonexistent/Xcode.app")');
	});

	test("Command Line Tools developer dir adds no extra grant (warren-11e6)", () => {
		const clt = buildSeatbeltProfile(baseProfile(), {
			developerDir: "/Library/Developer/CommandLineTools",
		});
		const none = buildSeatbeltProfile(baseProfile(), { developerDir: null });
		expect(clt).toBe(none);
		expect(none).not.toContain(".app/Contents");
	});

	test("xcodeBundleContents skips failed lookups and non-bundle dirs", () => {
		expect(xcodeBundleContents(null)).toBeNull();
		expect(xcodeBundleContents("")).toBeNull();
		expect(xcodeBundleContents("/opt/dev")).toBeNull();
		expect(xcodeBundleContents("/Library/Xcode.app/Contents/Developer")).toBeNull();
		expect(xcodeBundleContents("/nonexistent/Xcode-beta.app/Contents/Developer/")).toBe(
			"/nonexistent/Xcode-beta.app/Contents",
		);
	});

	test("resolveHostBunInstall prefers BUN_INSTALL over ~/.bun", () => {
		expect(resolveHostBunInstall({ BUN_INSTALL: "/opt/bun" }, "/Users/u")).toBe("/opt/bun");
		expect(resolveHostBunInstall({}, "/Users/u")).toBe("/Users/u/.bun");
		expect(resolveHostBunInstall({ BUN_INSTALL: "" }, "/Users/u")).toBe("/Users/u/.bun");
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

	test("workspaceGitdir is read-only with ordered write carve-outs (burrow-7a80, warren-8926)", () => {
		// Worktree-backed workspaces carry a `.git` *file* whose `gitdir:` points
		// at `<hostClonePath>/.git/worktrees/<id>`, outside the workspace subpath.
		// The common dir is readable but write-denied; only the carve-outs and the
		// packed-refs literals are writable, the carve-out roots cannot be
		// renamed away, and the admin binding files are denied again. SBPL applies the last matching rule, so order matters.
		const admin = "/Users/u/clone/.git/worktrees/ws";
		const out = buildSeatbeltProfile(
			baseProfile({
				workspaceGitdir: "/Users/u/clone/.git",
				workspaceGitWritable: [admin],
				workspaceGitProtected: [`${admin}/commondir`],
			}),
		);
		const rw = "file-read-data file-read-metadata file-write*";
		const rules = [
			'(allow file-read-data file-read-metadata (subpath "/Users/u/clone/.git"))',
			'(deny file-write* (subpath "/Users/u/clone/.git"))',
			`(allow ${rw} (literal "/Users/u/clone/.git/packed-refs.lock"))`,
			`(allow ${rw} (subpath "${admin}"))`,
			// The carve-out root itself cannot be renamed or removed.
			`(deny file-write-unlink (literal "${admin}"))`,
			`(deny file-write* (subpath "${admin}/commondir"))`,
		];
		let last = -1;
		for (const rule of rules) {
			const at = out.indexOf(rule);
			expect(at).toBeGreaterThan(last);
			last = at;
		}
		expect(out).not.toContain(`(allow ${rw} (subpath "/Users/u/clone/.git"))`);
		// Emitted after the broad /private/tmp grant so a clone there stays protected.
		expect(out.indexOf('(subpath "/private/tmp")')).toBeLessThan(out.indexOf(rules[1] ?? ""));
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
