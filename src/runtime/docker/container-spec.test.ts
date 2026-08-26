import { describe, expect, test } from "bun:test";
import type { SandboxProfile, SpawnCommand } from "../../sandbox/types.ts";
import { resolveDockerConfig } from "./config.ts";
import {
	buildDockerRunSpec,
	composeContainerEnv,
	containerNameForWorkspace,
	DOCKER_AGENT_GID,
	DOCKER_AGENT_UID,
	renderEnvFile,
	resolveDockerAgentUser,
} from "./container-spec.ts";

const config = resolveDockerConfig({ WARREN_DOCKER_AGENT_IMAGE: "warren-agent:test" });

function makeProfile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
	return {
		workspace: "/data/local/workspaces/local-run-1",
		home: "/data/local/homes/local-run-1",
		readOnlyMounts: [],
		network: "open",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
		...overrides,
	};
}

const command: SpawnCommand = { argv: ["claude", "--print", "hi"] };

describe("containerNameForWorkspace", () => {
	test("derives a deterministic prefixed name from the workspace basename", () => {
		expect(containerNameForWorkspace("/data/local/workspaces/local-run-1")).toBe(
			"warren-run-local-run-1",
		);
	});

	test("scrubs characters docker names reject", () => {
		expect(containerNameForWorkspace("/data/local/workspaces/bad id!")).toBe("warren-run-bad-id-");
	});
});

describe("resolveDockerAgentUser", () => {
	test("root host falls back to the K8s-parity uid 1000 and requests chown", () => {
		expect(resolveDockerAgentUser(makeProfile(), { uid: 0, gid: 0 })).toEqual({
			uid: DOCKER_AGENT_UID,
			gid: DOCKER_AGENT_GID,
			chownMounts: true,
		});
		expect(DOCKER_AGENT_UID).toBe(1000);
		expect(DOCKER_AGENT_GID).toBe(1000);
	});

	test("non-root host runs as the host uid and skips chown", () => {
		expect(resolveDockerAgentUser(makeProfile(), { uid: 501, gid: 20 })).toEqual({
			uid: 501,
			gid: 20,
			chownMounts: false,
		});
	});

	test("profile runAsUid wins over the host identity", () => {
		expect(
			resolveDockerAgentUser(makeProfile({ runAsUid: 1234, runAsGid: 1234 }), {
				uid: 501,
				gid: 20,
			}),
		).toEqual({ uid: 1234, gid: 1234, chownMounts: false });
		expect(resolveDockerAgentUser(makeProfile({ runAsUid: 1234 }), { uid: 0, gid: 0 })).toEqual({
			uid: 1234,
			gid: 1234,
			chownMounts: true,
		});
	});
});

describe("buildDockerRunSpec", () => {
	test("passes --user for the resolved non-root agent identity (warren-3f32)", () => {
		const asRoot = buildDockerRunSpec(makeProfile(), command, config, "/tmp/e.env", {
			uid: 0,
			gid: 0,
		});
		expect(asRoot.argv[asRoot.argv.indexOf("--user") + 1]).toBe(
			`${DOCKER_AGENT_UID}:${DOCKER_AGENT_GID}`,
		);
		const asHost = buildDockerRunSpec(makeProfile(), command, config, "/tmp/e.env", {
			uid: 501,
			gid: 20,
		});
		expect(asHost.argv[asHost.argv.indexOf("--user") + 1]).toBe("501:20");
	});

	test("pins --security-opt no-new-privileges so file caps + setuid bits stay inert (warren-950d)", () => {
		const spec = buildDockerRunSpec(makeProfile(), command, config, "/tmp/e.env");
		expect(spec.argv[spec.argv.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
	});

	test("agent image precedence: profile.agentImage > env config (warren-fabb)", () => {
		// config.image here is the env override ("warren-agent:test") — the
		// project override must win over it, and fall back to it when absent.
		const overridden = buildDockerRunSpec(
			makeProfile({ agentImage: "ghcr.io/acme/agent-py:1.0" }),
			command,
			config,
			"/tmp/e.env",
		);
		expect(overridden.argv).toContain("ghcr.io/acme/agent-py:1.0");
		expect(overridden.argv).not.toContain("warren-agent:test");

		const fallback = buildDockerRunSpec(makeProfile(), command, config, "/tmp/e.env");
		expect(fallback.argv).toContain("warren-agent:test");
	});

	test("bind-mounts workspace and home at identical paths, read-write", () => {
		const spec = buildDockerRunSpec(makeProfile(), command, config, "/tmp/e.env");
		expect(spec.argv).toContain(
			"type=bind,source=/data/local/workspaces/local-run-1,target=/data/local/workspaces/local-run-1",
		);
		expect(spec.argv).toContain(
			"type=bind,source=/data/local/homes/local-run-1,target=/data/local/homes/local-run-1",
		);
	});

	test("mounts read-only mounts readonly and the worktree gitdir read-write", () => {
		const spec = buildDockerRunSpec(
			makeProfile({
				readOnlyMounts: ["/opt/shared"],
				workspaceGitdir: "/repo/.git",
			}),
			command,
			config,
			"/tmp/e.env",
		);
		expect(spec.argv).toContain("type=bind,source=/opt/shared,target=/opt/shared,readonly");
		expect(spec.argv).toContain("type=bind,source=/repo/.git,target=/repo/.git");
	});

	test("maps network none to --network none and open to no flag", () => {
		const none = buildDockerRunSpec(makeProfile({ network: "none" }), command, config, "/tmp/e");
		expect(none.argv).toContain("--network");
		expect(none.argv[none.argv.indexOf("--network") + 1]).toBe("none");
		const open = buildDockerRunSpec(makeProfile({ network: "open" }), command, config, "/tmp/e");
		expect(open.argv).not.toContain("--network");
	});

	test("maps restricted to the default bridge when no network is configured", () => {
		const spec = buildDockerRunSpec(
			makeProfile({ network: "restricted" }),
			command,
			config,
			"/tmp/e",
		);
		expect(spec.argv[spec.argv.indexOf("--network") + 1]).toBe("bridge");
	});

	test("maps restricted to the configured docker network", () => {
		const custom = resolveDockerConfig({ WARREN_DOCKER_RESTRICTED_NETWORK: "warren-restricted" });
		const spec = buildDockerRunSpec(
			makeProfile({ network: "restricted" }),
			command,
			custom,
			"/tmp/e",
		);
		expect(spec.argv[spec.argv.indexOf("--network") + 1]).toBe("warren-restricted");
	});

	test("maps resource limits onto --memory and --cpus", () => {
		const spec = buildDockerRunSpec(
			makeProfile({ memoryLimitMb: 2048, cpuLimit: 1.5 }),
			command,
			config,
			"/tmp/e",
		);
		expect(spec.argv[spec.argv.indexOf("--memory") + 1]).toBe("2048m");
		expect(spec.argv[spec.argv.indexOf("--cpus") + 1]).toBe("1.5");
	});

	test("omits resource flags when the profile carries none", () => {
		const spec = buildDockerRunSpec(makeProfile(), command, config, "/tmp/e");
		expect(spec.argv).not.toContain("--memory");
		expect(spec.argv).not.toContain("--cpus");
	});

	test("attaches the host gateway and ends with the image and command argv", () => {
		const spec = buildDockerRunSpec(makeProfile(), command, config, "/tmp/e.env");
		expect(spec.argv).toContain("host.docker.internal:host-gateway");
		expect(spec.argv.slice(-3)).toEqual(["claude", "--print", "hi"]);
		expect(spec.argv[spec.argv.length - 4]).toBe("warren-agent:test");
	});

	test("forwards env passthrough names as bare --env entries", () => {
		const spec = buildDockerRunSpec(
			makeProfile({ envPassthrough: ["ANTHROPIC_API_KEY"] }),
			command,
			config,
			"/tmp/e",
		);
		const idx = spec.argv.indexOf("--env");
		expect(spec.argv[idx + 1]).toBe("ANTHROPIC_API_KEY");
	});

	test("resolves a relative command cwd against the workspace", () => {
		const spec = buildDockerRunSpec(
			makeProfile(),
			{ argv: ["pi"], cwd: "sub/dir" },
			config,
			"/tmp/e",
		);
		expect(spec.argv[spec.argv.indexOf("--workdir") + 1]).toBe(
			"/data/local/workspaces/local-run-1/sub/dir",
		);
	});
});

describe("composeContainerEnv", () => {
	test("rewrites a loopback WARREN_API_URL to the host gateway", () => {
		const env = composeContainerEnv(
			makeProfile({ setEnv: { WARREN_API_URL: "http://127.0.0.1:8080/api" } }),
			command,
			config,
		);
		expect(env.WARREN_API_URL).toBe("http://host.docker.internal:8080/api");
	});

	test("keeps a non-loopback WARREN_API_URL unchanged", () => {
		const env = composeContainerEnv(
			makeProfile({ setEnv: { WARREN_API_URL: "https://warren.example.com" } }),
			command,
			config,
		);
		expect(env.WARREN_API_URL).toBe("https://warren.example.com");
	});

	test("exports HOME at the run home and lets command env override profile env", () => {
		const env = composeContainerEnv(
			makeProfile({ setEnv: { FOO: "profile" } }),
			{ argv: ["pi"], env: { FOO: "command" } },
			config,
		);
		expect(env.FOO).toBe("command");
		expect(env.HOME).toBe("/data/local/homes/local-run-1");
	});
});

describe("renderEnvFile", () => {
	test("renders KEY=VALUE lines verbatim", () => {
		expect(renderEnvFile({ A: "1", B: "two words" })).toBe("A=1\nB=two words\n");
	});

	test("skips keys that are not valid env names", () => {
		expect(renderEnvFile({ "BAD KEY": "x", GOOD: "y" })).toBe("GOOD=y\n");
	});

	test("renders an empty map as an empty file", () => {
		expect(renderEnvFile({})).toBe("");
	});
});
