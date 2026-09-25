// Wall-clock cap precedence at dispatch (warren-a112): explicit override
// (POST /runs body / plan-run) > agent frontmatter > project-wide
// `.warren/config.yaml` maxDurationMinutes default. The folded value freezes
// onto rendered_agent_json, which is what the watchdog reads at enforcement.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { createWarrenConfigCache } from "../../warren-config/cache.ts";
import { resolveRunMaxDurationMinutes } from "../run-timeout.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

const durationConfigs = (maxDurationMinutes: number) =>
	createWarrenConfigCache({
		load: async () => ({
			triggers: null,
			defaults: { maxDurationMinutes },
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		}),
	});

describe("spawnRun: maxDurationMinutes precedence (warren-a112)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	async function frozenCap(
		frontmatter: Record<string, unknown>,
		override?: number,
	): Promise<unknown> {
		await repos.agents.upsert({
			name: "pi",
			renderedJson: makeAgentJson({ name: "pi", frontmatter }),
		});
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			warrenConfigs: durationConfigs(90),
			...(override !== undefined ? { maxDurationMinutesOverride: override } : {}),
		});
		const row = await repos.runs.require(result.run.id);
		return (row.renderedAgentJson as { frontmatter: Record<string, unknown> }).frontmatter
			.maxDurationMinutes;
	}

	test("applies the project default when the agent declares no cap", async () => {
		expect(await frozenCap({})).toBe(90);
	});

	test("keeps the agent's own cap over the project default", async () => {
		expect(await frozenCap({ maxDurationMinutes: 30 })).toBe(30);
	});

	test("leaves a malformed agent cap in place (fails open at the watchdog)", async () => {
		expect(await frozenCap({ maxDurationMinutes: "soon" })).toBe("soon");
		expect(resolveRunMaxDurationMinutes({ frontmatter: { maxDurationMinutes: "soon" } })).toBe(
			null,
		);
	});

	test("lets an explicit override win over the agent cap and the project default", async () => {
		expect(await frozenCap({ maxDurationMinutes: 30 }, 5)).toBe(5);
	});
});
