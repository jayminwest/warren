import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";
import type { SpawnLogger } from "./types.ts";

interface LogLine {
	readonly level: "info" | "warn" | "error";
	readonly obj: Record<string, unknown>;
	readonly msg?: string;
}

function makeRecordingLogger(): { logger: SpawnLogger; lines: LogLine[] } {
	const lines: LogLine[] = [];
	const make = (bindings: Record<string, unknown>): SpawnLogger => ({
		info: (obj, msg) => lines.push({ level: "info", obj: { ...bindings, ...obj }, msg }),
		warn: (obj, msg) => lines.push({ level: "warn", obj: { ...bindings, ...obj }, msg }),
		error: (obj, msg) => lines.push({ level: "error", obj: { ...bindings, ...obj }, msg }),
		child: (extra) => make({ ...bindings, ...(extra as Record<string, unknown>) }),
	});
	return { logger: make({}), lines };
}

describe("spawnRun: agent git identity env (warren-4e36)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("forwards WARREN_GIT_AUTHOR_* as the four GIT_* identity vars", async () => {
		// On K8s there is no supervisor gitconfig install — without these the
		// in-pod `git commit` fails with "Author identity unknown" exit 128.
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			serverEnv: {
				WARREN_GIT_AUTHOR_NAME: "warren",
				WARREN_GIT_AUTHOR_EMAIL: "op+warren@users.noreply.github.com",
			},
		});
		const up = calls.find((c) => c.path === "/sandboxes");
		const env = (up?.body as { env?: Record<string, string> }).env;
		expect(env?.GIT_AUTHOR_NAME).toBe("warren");
		expect(env?.GIT_AUTHOR_EMAIL).toBe("op+warren@users.noreply.github.com");
		expect(env?.GIT_COMMITTER_NAME).toBe("warren");
		expect(env?.GIT_COMMITTER_EMAIL).toBe("op+warren@users.noreply.github.com");
	});

	test("git identity is all-or-nothing: half a pair injects none of the GIT_* vars", async () => {
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			serverEnv: { WARREN_GIT_AUTHOR_NAME: "warren", WARREN_GIT_AUTHOR_EMAIL: "  " },
		});
		const up = calls.find((c) => c.path === "/sandboxes");
		const env = (up?.body as { env?: Record<string, string> }).env;
		expect(env?.GIT_AUTHOR_NAME).toBeUndefined();
		expect(env?.GIT_AUTHOR_EMAIL).toBeUndefined();
		expect(env?.GIT_COMMITTER_NAME).toBeUndefined();
		expect(env?.GIT_COMMITTER_EMAIL).toBeUndefined();
	});
});

describe("spawnRun: unconfigured git identity surfacing (warren-e7b7)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("k8s + unset vars warns exactly once per dispatch", async () => {
		// No supervisor exists on the K8s topology to warn — the per-run
		// structured warn is the only operator-facing signal.
		const { client } = makeSandboxClient();
		const { logger, lines } = makeRecordingLogger();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			logger,
			serverEnv: { WARREN_RUNTIME: "k8s" },
		});
		const warns = lines.filter((l) => l.obj.event === "spawn.git_identity_unconfigured");
		expect(warns).toHaveLength(1);
		expect(warns[0]?.level).toBe("warn");
		expect(warns[0]?.msg).toContain("WARREN_GIT_AUTHOR_NAME");
		expect(warns[0]?.obj.run_id).toBeDefined();
	});

	test("k8s + configured vars emits no identity warn", async () => {
		const { client } = makeSandboxClient();
		const { logger, lines } = makeRecordingLogger();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			logger,
			serverEnv: {
				WARREN_RUNTIME: "k8s",
				WARREN_GIT_AUTHOR_NAME: "warren",
				WARREN_GIT_AUTHOR_EMAIL: "op+warren@users.noreply.github.com",
			},
		});
		expect(lines.filter((l) => l.obj.event === "spawn.git_identity_unconfigured")).toHaveLength(0);
	});

	test("local topology stays silent (the supervisor already warns)", async () => {
		const { client } = makeSandboxClient();
		const { logger, lines } = makeRecordingLogger();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			logger,
			serverEnv: {},
		});
		expect(lines.filter((l) => l.obj.event === "spawn.git_identity_unconfigured")).toHaveLength(0);
	});
});
