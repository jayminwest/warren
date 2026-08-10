// Cap-chain precedence at dispatch (warren-a63d): explicit override
// (trigger / POST /runs body) > agent frontmatter > project-wide
// `.warren/config.yaml` maxCostUsd default. The folded value freezes onto
// rendered_agent_json / dispatch metadata, which is what the bridge reads
// at enforcement time. Sibling of dispatch.test.ts (check:size budget).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { createWarrenConfigCache } from "../../warren-config/cache.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeBurrowClient, makeProvider, setupRepos } from "./test-helpers.ts";

const capConfigs = (maxCostUsd: number) =>
	createWarrenConfigCache({
		load: async () => ({
			triggers: null,
			defaults: { maxCostUsd },
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		}),
	});

const dispatchedFrontmatter = (
	calls: readonly { path: string; body?: unknown }[],
): Record<string, unknown> => {
	const dispatch = calls.find((c) => c.path === "/burrows/bur_aaaaaaaaaaaa/runs");
	const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
	return body.metadata.frontmatter;
};

describe("spawnRun: maxCostUsd precedence (warren-a63d)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("applies the project-default maxCostUsd when the agent carries no cap", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({ name: "pi", frontmatter: {} }),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			warrenConfigs: capConfigs(2.5),
		});
		expect(dispatchedFrontmatter(calls).maxCostUsd).toBe(2.5);
	});

	test("keeps the agent's own maxCostUsd over the project default", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({ name: "pi", frontmatter: { maxCostUsd: 1 } }),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			warrenConfigs: capConfigs(2.5),
		});
		expect(dispatchedFrontmatter(calls).maxCostUsd).toBe(1);
	});

	test("leaves a malformed agent cap in place instead of papering over it with the project default", async () => {
		// Fail-open contract: an unreadable agent cap means "no cap", and the
		// frozen rendered_agent_json must keep the typo'd value as evidence.
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({ name: "pi", frontmatter: { maxCostUsd: "5O" } }),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			warrenConfigs: capConfigs(2.5),
		});
		expect(dispatchedFrontmatter(calls).maxCostUsd).toBe("5O");
	});

	test("lets an explicit maxCostUsdOverride win over the agent cap and the project default", async () => {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({ name: "pi", frontmatter: { maxCostUsd: 1 } }),
		});
		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			maxCostUsdOverride: 0.75,
			warrenConfigs: capConfigs(2.5),
		});
		expect(dispatchedFrontmatter(calls).maxCostUsd).toBe(0.75);
	});
});
