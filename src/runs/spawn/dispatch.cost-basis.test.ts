import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

/**
 * Cost-basis stamping (warren-f3c3 / pl-26f3 step 5): the run row's
 * `costBasis` is frozen at dispatch from the credential shape of the
 * server env that forwards into the sandbox. Split out of
 * `dispatch.test.ts` for the per-file size budget.
 */
describe("spawnRun: costBasis", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("stamps subscription_estimate when only CLAUDE_CODE_OAUTH_TOKEN authenticates", async () => {
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			serverEnv: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-grant" },
		});
		expect((await repos.runs.require(result.run.id)).costBasis).toBe("subscription_estimate");
	});

	test("stamps api when the API key is present even alongside the OAuth token", async () => {
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			serverEnv: {
				CLAUDE_CODE_OAUTH_TOKEN: "oauth-grant",
				ANTHROPIC_API_KEY: "sk-ant",
			},
		});
		expect((await repos.runs.require(result.run.id)).costBasis).toBe("api");
	});
});
