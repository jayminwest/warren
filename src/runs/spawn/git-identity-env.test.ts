import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeBurrowClient, makeProvider, setupRepos } from "./test-helpers.ts";

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
		const { client, calls } = makeBurrowClient();
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
		const up = calls.find((c) => c.path === "/burrows");
		const env = (up?.body as { env?: Record<string, string> }).env;
		expect(env?.GIT_AUTHOR_NAME).toBe("warren");
		expect(env?.GIT_AUTHOR_EMAIL).toBe("op+warren@users.noreply.github.com");
		expect(env?.GIT_COMMITTER_NAME).toBe("warren");
		expect(env?.GIT_COMMITTER_EMAIL).toBe("op+warren@users.noreply.github.com");
	});

	test("git identity is all-or-nothing: half a pair injects none of the GIT_* vars", async () => {
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix it",
			serverEnv: { WARREN_GIT_AUTHOR_NAME: "warren", WARREN_GIT_AUTHOR_EMAIL: "  " },
		});
		const up = calls.find((c) => c.path === "/burrows");
		const env = (up?.body as { env?: Record<string, string> }).env;
		expect(env?.GIT_AUTHOR_NAME).toBeUndefined();
		expect(env?.GIT_AUTHOR_EMAIL).toBeUndefined();
		expect(env?.GIT_COMMITTER_NAME).toBeUndefined();
		expect(env?.GIT_COMMITTER_EMAIL).toBeUndefined();
	});
});
