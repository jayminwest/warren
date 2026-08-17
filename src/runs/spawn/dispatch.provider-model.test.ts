import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { DefaultsConfig, WarrenConfigCache } from "../../warren-config/index.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

function configWith(defaults: DefaultsConfig): WarrenConfigCache {
	return {
		get: async () => ({
			triggers: null,
			defaults,
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		}),
		invalidate: () => undefined,
		clear: () => undefined,
		size: () => 0,
	};
}

async function captureValidation(promise: Promise<unknown>): Promise<ValidationError> {
	try {
		await promise;
		throw new Error("expected provider/model validation to reject dispatch");
	} catch (error) {
		if (!(error instanceof ValidationError)) throw error;
		return error;
	}
}

describe("spawnRun: provider/model compatibility (warren-bad5)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("rejects an Anthropic model override against the OpenRouter project default", async () => {
		const { client, calls } = makeSandboxClient();
		const error = await captureValidation(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "run",
				modelOverride: "claude-opus-4-8",
				warrenConfigs: configWith({ defaultProvider: "openrouter" }),
			}),
		);

		expect(error.message).toContain('model "claude-opus-4-8"');
		expect(error.message).toContain('provider "openrouter"');
		expect(error.recoveryHint).toContain("vendor/model");
		expect(calls).toHaveLength(0);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("rejects an OpenRouter-shaped agent model against an Anthropic override", async () => {
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: makeAgentJson({
				frontmatter: { model: "moonshotai/kimi-k3" },
			}),
		});
		const { client, calls } = makeSandboxClient();
		const error = await captureValidation(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "run",
				providerOverride: "anthropic",
			}),
		);

		expect(error.message).toContain('model "moonshotai/kimi-k3"');
		expect(error.message).toContain('provider "anthropic"');
		expect(error.recoveryHint).toContain("slashless Anthropic model id");
		expect(calls).toHaveLength(0);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("rejects a casing variant of a known provider via the core registry (warren-fb8d)", async () => {
		const { client, calls } = makeSandboxClient();
		const error = await captureValidation(
			spawnRun({
				repos,
				runtimeProvider: makeProvider(client),
				agentName: "refactor-bot",
				projectId: "prj_xxxxxxxxxxxx",
				prompt: "run",
				providerOverride: "OpenRouter",
				modelOverride: "claude-opus-4-8",
			}),
		);

		expect(error.message).toContain('provider "OpenRouter"');
		expect(calls).toHaveLength(0);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test.each<[string, string]>([
		["openrouter", "moonshotai/kimi-k3"],
		["anthropic", "claude-opus-4-8"],
		["openrouter", "gpt-4o"],
		["openrouter", "Claude-opus-4-8"],
		["openrouter", "claude-opus/experimental"],
		["custom-provider", "vendor/model"],
	])("allows compatible or ambiguous pair %s / %s", async (provider, model) => {
		const { client, calls } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "run",
			providerOverride: provider,
			modelOverride: model,
		});

		expect(result.run.provider).toBe(provider);
		expect(result.run.model).toBe(model);
		expect(calls).toHaveLength(2);
	});
});
