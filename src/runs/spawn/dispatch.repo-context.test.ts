/**
 * warren-540f: per-project `repoContext` — the `.warren/config.yaml`
 * onboarding block injected into every dispatched agent's prompt by
 * `composeDispatchPrompt`, and its accounting in the dispatch-context
 * `prompt_bytes`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { composeDispatchPrompt, spawnRun } from "./index.ts";
import { makeAgentJson, makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

describe("composeDispatchPrompt: repoContext (warren-540f)", () => {
	test("injects repoContext between the system body and the user prompt", () => {
		expect(composeDispatchPrompt("system body", "fix it", "python repo, gate is pytest -q")).toBe(
			"system body\n\n---\n\npython repo, gate is pytest -q\n\n---\n\nfix it",
		);
	});

	test("injects repoContext even when there is no system body", () => {
		expect(composeDispatchPrompt(undefined, "fix it", "no tracker here")).toBe(
			"no tracker here\n\n---\n\nfix it",
		);
	});

	test("blank repoContext is dropped, matching the no-config composition exactly", () => {
		expect(composeDispatchPrompt("system", "task", "")).toBe(
			composeDispatchPrompt("system", "task"),
		);
		expect(composeDispatchPrompt("", "task", "   \n")).toBe("task");
		expect(composeDispatchPrompt("system", "task", undefined)).toBe("system\n\n---\n\ntask");
	});
});

describe("spawnRun: repoContext (warren-540f)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	const warrenConfigs = (repoContext: string) => ({
		get: async () => ({
			triggers: null,
			defaults: { repoContext },
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		}),
		invalidate: () => undefined,
		clear: () => undefined,
		size: () => 0,
	});

	test("injects project repoContext into the dispatched prompt", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				sections: { system: "you are a refactor agent" },
			}),
		});
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix the flaky test",
			warrenConfigs: warrenConfigs("python repo; gate is pytest -q; no tracker"),
		});

		const dispatch = calls.find((c) => c.path === "/sandboxes/bur_aaaaaaaaaaaa/runs");
		expect(dispatch).toBeDefined();
		const body = dispatch?.body as { prompt: string };
		expect(body.prompt).toBe(
			"you are a refactor agent\n\n---\n\npython repo; gate is pytest -q; no tracker\n\n---\n\nfix the flaky test",
		);
	});

	test("counts repoContext bytes into the dispatch-context prompt_bytes", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({
				name: "pi",
				frontmatter: { provider: "anthropic", model: "claude-sonnet-4" },
			}),
		});
		const repoContext = "python repo; gate is pytest -q";
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "fix the flaky test",
			warrenConfigs: warrenConfigs(repoContext),
		});

		const ctx = await repos.dispatchContext.getByRunId(result.run.id);
		expect(ctx?.promptBytes).toBe(
			new TextEncoder().encode("fix the flaky test").byteLength +
				new TextEncoder().encode(repoContext).byteLength,
		);
	});
});
