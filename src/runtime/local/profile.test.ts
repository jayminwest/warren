import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_PROVIDER_NAMES, PROVIDER_ENV_REGISTRY } from "../../core/providers.ts";
import type { MaterializedWorkspace } from "../../workspace/materialize.ts";
import type { RunSpec } from "../contract.ts";
import {
	buildLocalSandboxProfile,
	PI_PROVIDER_ENV_KEYS,
	parseSandboxSection,
	readLocalSandboxConfig,
	resolveEnvPassthrough,
	resolveToolchainPaths,
} from "./profile.ts";

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: "run_p1",
		originUrl: "https://github.com/o/r.git",
		branch: "warren/run_p1",
		baseBranch: "main",
		runtimeId: "claude-code",
		prompt: "do it",
		mode: "batch",
		network: "open",
		seedFiles: [],
		env: {},
		...overrides,
	};
}

function fakeWorkspace(path = "/tmp/ws"): MaterializedWorkspace {
	return {
		workspacePath: path,
		source: { kind: "clone", branch: "warren/run_p1" },
		identity: null,
	};
}

describe("resolveEnvPassthrough", () => {
	test("returns the claude-code allowlist", () => {
		expect(resolveEnvPassthrough("claude-code", undefined)).toContain("ANTHROPIC_API_KEY");
		expect(resolveEnvPassthrough("claude-code", undefined)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
	});

	test("returns the pi base allowlist with no provider override", () => {
		expect(resolveEnvPassthrough("pi", undefined)).toEqual([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"EXA_API_KEY",
		]);
	});

	test("unions the provider key delta for a non-anthropic pi provider", () => {
		expect(resolveEnvPassthrough("pi", { provider: "openai" })).toContain("OPENAI_API_KEY");
		expect(resolveEnvPassthrough("pi", { provider: "google" })).toContain("GEMINI_API_KEY");
		// case-insensitive, matching burrow's normalization
		expect(resolveEnvPassthrough("pi", { provider: "OpenAI" })).toContain("OPENAI_BASE_URL");
	});

	test("warren-81e0: forwards the openrouter key set for an openrouter pi run", () => {
		// Regression: a project `defaultProvider: openrouter` (e.g. warren's own
		// `.warren/config.yaml`) folds onto the pi argv as `--provider openrouter`,
		// but the burrow-inherited PI_PROVIDER_ENV_KEYS lacked openrouter, so the
		// key never entered the sandbox/container and pi died with
		// "No API key found for openrouter" despite the operator holding it.
		const passthrough = resolveEnvPassthrough("pi", { provider: "openrouter" });
		expect(passthrough).toContain("OPENROUTER_API_KEY");
		expect(passthrough).toContain("OPENROUTER_BASE_URL");
		expect(passthrough).toContain("ANTHROPIC_API_KEY"); // base rides along
	});

	test("warren-81e0: PI_PROVIDER_ENV_KEYS covers the canonical provider registry", () => {
		// Drift guard: every non-anthropic provider in PROVIDER_ENV_REGISTRY
		// (src/core/providers.ts) must contribute its full key set here, so the
		// local/docker passthrough can never again lag dispatch-time vocabulary.
		for (const name of KNOWN_PROVIDER_NAMES) {
			if (name === "anthropic") continue;
			const registration = PROVIDER_ENV_REGISTRY[name];
			for (const key of [...registration.envKeys, ...registration.optionalEnvKeys]) {
				expect(PI_PROVIDER_ENV_KEYS[name]).toContain(key);
			}
		}
	});

	test("keeps the pi base for the default provider and unknown providers", () => {
		expect(resolveEnvPassthrough("pi", { provider: "anthropic" })).not.toContain("OPENAI_API_KEY");
		expect(resolveEnvPassthrough("pi", { provider: "mystery" })).not.toContain("OPENAI_API_KEY");
	});

	test("returns no passthrough for an unknown runtime", () => {
		expect(resolveEnvPassthrough("codex", undefined)).toEqual([]);
	});
});

describe("resolveToolchainPaths", () => {
	// Empty third arg suppresses the host bun-install auto-grant so these
	// tests stay hermetic regardless of whether ~/.bun exists on the runner.
	test("adds the resolved bin dir for agent + common binaries", () => {
		const which = (name: string): string | null =>
			name === "claude" ? "/home/dev/.local/bin/claude" : null;
		const dirs = resolveToolchainPaths("claude-code", which, "");
		expect(dirs).toContain("/home/dev/.local/bin");
	});

	test("keeps system-mounted bin dirs for the PATH contribution", () => {
		const which = (name: string): string | null => (name === "git" ? "/usr/bin/git" : null);
		const dirs = resolveToolchainPaths("pi", which, "");
		expect(dirs).toContain("/usr/bin");
	});

	test("skips binaries that do not resolve and dedupes dirs", () => {
		const dirs = resolveToolchainPaths("claude-code", () => null, "");
		expect(dirs).toEqual([]);
	});

	test("adds the host bun install root and global modules when present (warren-bea7)", () => {
		const root = mkdtempSync(join(tmpdir(), "warren-bun-install-"));
		try {
			const globalModules = join(root, "install/global/node_modules");
			mkdirSync(globalModules, { recursive: true });
			const dirs = resolveToolchainPaths("claude-code", () => null, root);
			expect(dirs).toContain(root);
			expect(dirs).toContain(globalModules);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("skips a missing host bun install root", () => {
		const dirs = resolveToolchainPaths(
			"claude-code",
			() => null,
			"/no/such/bun-install-root-warren-bea7",
		);
		expect(dirs).toEqual([]);
	});
});

describe("parseSandboxSection", () => {
	test("parses the [sandbox] scalars and arrays", () => {
		const config = parseSandboxSection(
			[
				"[sandbox]",
				'allowed_domains = ["api.anthropic.com", "github.com"]',
				'read_only_paths = ["~/.claude"]',
				"memory_limit_mb = 4096",
				"cpu_limit = 2",
				"timeout_minutes = 30",
				"",
				"[env]",
				'ignored = "yes"',
			].join("\n"),
		);
		expect(config.allowedDomains).toEqual(["api.anthropic.com", "github.com"]);
		expect(config.readOnlyPaths).toEqual(["~/.claude"]);
		expect(config.memoryLimitMb).toBe(4096);
		expect(config.cpuLimit).toBe(2);
		expect(config.timeoutMs).toBe(30 * 60_000);
	});

	test("ignores keys outside [sandbox] and malformed values", () => {
		const config = parseSandboxSection('[other]\nmemory_limit_mb = 1\n[sandbox]\ncpu_limit = "x"');
		expect(config.memoryLimitMb).toBeUndefined();
		expect(config.cpuLimit).toBeUndefined();
	});

	test("returns an empty config for an empty body", () => {
		expect(parseSandboxSection("")).toEqual({});
	});
});

describe("readLocalSandboxConfig", () => {
	test("reads burrow.toml off the project root", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-profile-"));
		try {
			writeFileSync(join(root, "burrow.toml"), "[sandbox]\nmemory_limit_mb = 2048\n");
			const config = await readLocalSandboxConfig(root);
			expect(config.memoryLimitMb).toBe(2048);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("yields an empty config when no burrow.toml exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-profile-"));
		try {
			expect(await readLocalSandboxConfig(root)).toEqual({});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("buildLocalSandboxProfile", () => {
	test("binds the workspace and the separate writable HOME (warren-c865)", async () => {
		const profile = await buildLocalSandboxProfile({
			spec: makeSpec(),
			env: { WARREN_QUALITY_GATE: "verify" },
			workspace: fakeWorkspace(),
			homePath: "/tmp/home/run_p1",
		});
		expect(profile.workspace).toBe("/tmp/ws");
		expect(profile.home).toBe("/tmp/home/run_p1");
		expect(profile.home).not.toBe(profile.workspace);
		expect(profile.setEnv.WARREN_QUALITY_GATE).toBe("verify");
		expect(profile.envPassthrough).toContain("ANTHROPIC_API_KEY");
	});

	test("mounts the git common dir for worktree-backed workspaces", async () => {
		const workspace: MaterializedWorkspace = {
			workspacePath: "/tmp/ws",
			source: {
				kind: "worktree",
				branch: "warren/run_p1",
				hostClonePath: "/data/projects/x/y",
				gitCommonDir: "/data/projects/x/y/.git",
			},
			identity: null,
		};
		const profile = await buildLocalSandboxProfile({
			spec: makeSpec(),
			env: {},
			workspace,
			homePath: "/tmp/home",
		});
		expect(profile.workspaceGitdir).toBe("/data/projects/x/y/.git");
	});

	test("per-run resources win over burrow.toml limits", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-profile-"));
		try {
			writeFileSync(join(root, "burrow.toml"), "[sandbox]\nmemory_limit_mb = 1024\n");
			const profile = await buildLocalSandboxProfile({
				spec: makeSpec({
					hostClonePathHint: root,
					resources: { memoryMiB: 8192, cpuMillicores: 1500 },
				}),
				env: {},
				workspace: fakeWorkspace(),
				homePath: "/tmp/home",
			});
			expect(profile.memoryLimitMb).toBe(8192);
			expect(profile.cpuLimit).toBe(1.5);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("falls back to burrow.toml limits when the spec is silent", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-profile-"));
		try {
			writeFileSync(
				join(root, "burrow.toml"),
				'[sandbox]\nmemory_limit_mb = 3072\nallowed_domains = ["api.anthropic.com"]\ntimeout_minutes = 5\n',
			);
			const profile = await buildLocalSandboxProfile({
				spec: makeSpec({ hostClonePathHint: root, network: "restricted" }),
				env: {},
				workspace: fakeWorkspace(),
				homePath: "/tmp/home",
			});
			expect(profile.memoryLimitMb).toBe(3072);
			expect(profile.allowedDomains).toEqual(["api.anthropic.com"]);
			expect(profile.timeoutMs).toBe(300_000);
			expect(profile.network).toBe("restricted");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("spec timeoutMs wins over burrow.toml timeout_minutes", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-profile-"));
		try {
			writeFileSync(join(root, "burrow.toml"), "[sandbox]\ntimeout_minutes = 5\n");
			const profile = await buildLocalSandboxProfile({
				spec: makeSpec({ hostClonePathHint: root, timeoutMs: 60_000 }),
				env: {},
				workspace: fakeWorkspace(),
				homePath: "/tmp/home",
			});
			expect(profile.timeoutMs).toBe(60_000);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("resolves the pi provider env delta off the run frontmatter", async () => {
		const profile = await buildLocalSandboxProfile({
			spec: makeSpec({ runtimeId: "pi" }),
			env: {},
			workspace: fakeWorkspace(),
			homePath: "/tmp/home",
			frontmatter: { provider: "groq" },
		});
		expect(profile.envPassthrough).toContain("GROQ_API_KEY");
	});
});

describe("resolveToolchainPaths (WARREN_SANDBOX_GIT override, warren-1219)", () => {
	const ENV = "WARREN_SANDBOX_GIT";

	afterEach(() => {
		delete process.env[ENV];
	});

	test("prefers the preflight substitution over PATH resolution for git", () => {
		process.env[ENV] = "/usr/bin/git";
		const which = (name: string): string | null =>
			name === "git" ? "/nix/store/abc-git/bin/git" : null;
		const dirs = resolveToolchainPaths("pi", which, "");
		expect(dirs).toContain("/usr/bin");
		expect(dirs).not.toContain("/nix/store/abc-git/bin");
	});

	test("still uses PATH resolution for git when no override is set", () => {
		const which = (name: string): string | null =>
			name === "git" ? "/nix/store/abc-git/bin/git" : null;
		const dirs = resolveToolchainPaths("pi", which, "");
		expect(dirs).toContain("/nix/store/abc-git/bin");
	});
});
