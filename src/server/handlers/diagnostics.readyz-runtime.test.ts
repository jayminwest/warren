/**
 * `/readyz` runtime-topology scoping (warren-c128). The bwrap and
 * stale-burrow-workspace probes only make sense for the local backend, where
 * warren runs sandboxes in-process on the host. Under `WARREN_RUNTIME=k8s`
 * agents run in pods and bwrap lives in the agent image, so those probes must
 * be scoped out of readiness rather than reporting "bwrap not found" and
 * degrading an otherwise-healthy control plane. The burrow-daemon socket probe
 * died with the daemon (warren-9a26) — there is no `burrow_reachable` check on
 * either topology anymore.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { RouteContext, ServerDeps } from "../types.ts";
import { readyzHandler } from "./diagnostics.ts";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Spawn stub that fails `bwrap --version` (host has no bubblewrap). */
const failBwrap: SpawnFn = async (cmd) => {
	if (cmd[0]?.endsWith("bwrap")) return { stdout: "", stderr: "not found", exitCode: 127 };
	return { stdout: "", stderr: "", exitCode: 0 };
};

/** Spawn stub with no docker CLI on $PATH — the quickstart failure (warren-5c42). */
const noDockerCli: SpawnFn = async (cmd) => {
	if (cmd[0]?.endsWith("docker")) throw new Error('Executable not found in $PATH: "docker"');
	return { stdout: "", stderr: "", exitCode: 0 };
};

interface ReadyzProbe {
	status: number;
	names: string[];
	ok: boolean;
	checks: { name: string; ok: boolean; message?: string; hint?: string }[];
}

async function readyzChecks(
	db: WarrenDb,
	k8sPodSync?: { isSynced(): boolean },
	spawn: SpawnFn = failBwrap,
): Promise<ReadyzProbe> {
	const repos = createRepos(db);
	await repos.agents.upsert({
		name: "refactor-bot",
		renderedJson: { name: "refactor-bot", sections: { system: "x" } },
	});
	const deps = {
		repos,
		db,
		spawn,
		// Pin the probe to Linux semantics: checkBwrap self-skips on non-Linux
		// platforms, so without this the "no bwrap ⇒ 503" premise only holds
		// on Linux hosts and the test flips green/red by machine (warren-4de5).
		platform: "linux" satisfies NodeJS.Platform,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(k8sPodSync !== undefined ? { k8sPodSync } : {}),
	} as unknown as ServerDeps;
	const res = await readyzHandler(deps)({} as RouteContext);
	const body = (await res.json()) as { ok: boolean; checks: ReadyzProbe["checks"] };
	return {
		status: res.status,
		ok: body.ok,
		names: body.checks.map((c) => c.name),
		checks: body.checks,
	};
}

describe("/readyz runtime-topology scoping (warren-c128)", () => {
	const prev = process.env.WARREN_RUNTIME;
	const prevDockerBin = process.env.WARREN_DOCKER_BIN;
	let db: WarrenDb | null = null;

	afterEach(async () => {
		if (prev === undefined) delete process.env.WARREN_RUNTIME;
		else process.env.WARREN_RUNTIME = prev;
		if (prevDockerBin === undefined) delete process.env.WARREN_DOCKER_BIN;
		else process.env.WARREN_DOCKER_BIN = prevDockerBin;
		await db?.close();
		db = null;
	});

	test("local backend still weighs the bwrap probe (no bwrap ⇒ 503), with no burrow probe", async () => {
		process.env.WARREN_RUNTIME = "local";
		db = await openDatabase({ path: ":memory:" });
		const { status, names } = await readyzChecks(db);
		expect(status).toBe(503);
		expect(names).toContain("bwrap");
		expect(names).not.toContain("burrow_reachable");
		// The docker probe is scoped to the docker topology (warren-5c42).
		expect(names).not.toContain("docker_cli");
	});

	test("k8s backend scopes local-sandbox probes out entirely (⇒ 200)", async () => {
		process.env.WARREN_RUNTIME = "k8s";
		db = await openDatabase({ path: ":memory:" });
		const { status, ok, names } = await readyzChecks(db, { isSynced: () => true });
		expect(status).toBe(200);
		expect(ok).toBe(true);
		expect(names).not.toContain("burrow_reachable");
		expect(names).not.toContain("bwrap");
		expect(names).not.toContain("stale_sandbox_workspaces");
		// The topology-relevant checks survive.
		expect(names).toContain("db_reachable");
		expect(names).toContain("agents");
		expect(names).not.toContain("docker_cli");
	});

	// warren-5c42: the docker topology dispatches every agent through the
	// docker CLI, so a broken CLI must fail readiness rather than boot green
	// and die at the first dispatch with `Executable not found in $PATH`.
	test("docker backend weighs the docker CLI probe (no CLI ⇒ 503) and skips bwrap", async () => {
		process.env.WARREN_RUNTIME = "docker";
		db = await openDatabase({ path: ":memory:" });
		const { status, names, checks } = await readyzChecks(db, undefined, noDockerCli);
		expect(status).toBe(503);
		expect(names).toContain("docker_cli");
		expect(names).not.toContain("bwrap");
		expect(names).not.toContain("stale_sandbox_workspaces");
		expect(names).not.toContain("k8s_api_reachable");
		const docker = checks.find((c) => c.name === "docker_cli");
		expect(docker?.ok).toBe(false);
		expect(docker?.message).toContain("Executable not found in $PATH");
		// The hint names the macOS Docker Desktop trap and the way out.
		expect(docker?.hint).toContain("WARREN_DOCKER_BIN");
	});

	test("docker backend is ready when the CLI reaches the daemon (⇒ 200)", async () => {
		process.env.WARREN_RUNTIME = "docker";
		db = await openDatabase({ path: ":memory:" });
		const okSpawn: SpawnFn = async () => ({ stdout: "Server: 27.0.3", stderr: "", exitCode: 0 });
		const { status, ok, checks } = await readyzChecks(db, undefined, okSpawn);
		expect(status).toBe(200);
		expect(ok).toBe(true);
		expect(checks.find((c) => c.name === "docker_cli")?.ok).toBe(true);
	});

	test("docker backend honors WARREN_DOCKER_BIN in the probe argv", async () => {
		process.env.WARREN_RUNTIME = "docker";
		process.env.WARREN_DOCKER_BIN = "/srv/warren/bin/docker";
		db = await openDatabase({ path: ":memory:" });
		const seen: string[][] = [];
		const spawn: SpawnFn = async (cmd) => {
			seen.push([...cmd]);
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		await readyzChecks(db, undefined, spawn);
		expect(seen).toContainEqual(["/srv/warren/bin/docker", "version"]);
	});
});
