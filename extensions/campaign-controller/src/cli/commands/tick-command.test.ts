/**
 * The `tick` command's bot-grammar wiring (warren-8c83): the grammar file
 * resolves from --grammar or CAMPAIGN_BOT_GRAMMAR_PATH, and a bad path or an
 * invalid grammar fails the tick loudly at startup — never a silent skip.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../errors.ts";
import { type CliConfig, ENV_BOT_GRAMMAR_PATH, resolveConfig } from "../config.ts";
import { runTickCommand, type TickCommandDeps } from "./tick-command.ts";

const NOW_POLICY = {
	schemaVersion: 1,
	profileId: "openclaw",
	upstream: { owner: "openclaw", repo: "openclaw" },
	source: {
		url: "https://raw.githubusercontent.com/openclaw/openclaw/main/CONTRIBUTING.md",
		fetchedAt: "2026-08-20T00:00:00.000Z",
		sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	},
	stalenessMaxDays: 90,
	issueFirstRequired: true,
	aiDisclosure: { required: true, evidenceRequired: true },
	allowedWorkTypes: ["bug-fix"],
	forbiddenPaths: [],
	protectedPaths: [],
	upstreamObservedMaxOpenPrs: 20,
	maxOpenPrs: 5,
	maxNewPrsPerDay: 2,
	requiredChecks: ["ci"],
	mutations: {
		createPullRequest: false,
		followUpPush: false,
		updatePullRequest: false,
		pushCommits: false,
		updateBranch: false,
		postComment: false,
		editComment: false,
		requestReview: false,
		addLabels: false,
		closePullRequest: false,
		reopenPullRequest: false,
		enableAutoMerge: false,
		mergePullRequest: false,
		editIssue: false,
	},
};

/** Both startup-failure tests abort before the clock or id source is touched. */
const TICK_DEPS: TickCommandDeps = {
	clock: { nowMs: () => 0 },
	ids: { newId: () => "id-0" },
};

function baseConfig(overrides: Partial<CliConfig> = {}): CliConfig {
	return {
		dbPath: null,
		manifestPath: null,
		amendmentPath: null,
		policyPath: null,
		botGrammarPath: null,
		summariesPath: null,
		warrenBaseUrl: null,
		githubBaseUrl: null,
		warrenToken: "tok",
		githubToken: null,
		...overrides,
	};
}

describe("resolveConfig bot grammar path", () => {
	test("resolves from CAMPAIGN_BOT_GRAMMAR_PATH and the --grammar flag", () => {
		expect(resolveConfig({}, { [ENV_BOT_GRAMMAR_PATH]: "/tmp/g.json" }).botGrammarPath).toBe(
			"/tmp/g.json",
		);
		expect(resolveConfig({ grammar: "/tmp/flag.json" }, {}).botGrammarPath).toBe("/tmp/flag.json");
		expect(resolveConfig({}, {}).botGrammarPath).toBeNull();
	});
});

describe("runTickCommand bot grammar loading", () => {
	test("a missing grammar file fails loudly with a ConfigError before any IO", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tick-grammar-"));
		try {
			const policyPath = join(dir, "policy.json");
			writeFileSync(policyPath, JSON.stringify(NOW_POLICY));
			await expect(
				runTickCommand(
					baseConfig({
						policyPath,
						botGrammarPath: join(dir, "nope.json"),
						warrenBaseUrl: "http://warren.test",
						dbPath: ":memory:",
					}),
					TICK_DEPS,
					{ campaign: "camp-x" },
				),
			).rejects.toThrow("cannot read the bot grammar file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an invalid grammar file fails validation loudly at startup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tick-grammar-"));
		try {
			const policyPath = join(dir, "policy.json");
			writeFileSync(policyPath, JSON.stringify(NOW_POLICY));
			const grammarPath = join(dir, "grammar.json");
			writeFileSync(grammarPath, JSON.stringify({ knownBotLogins: ["ok-bot"] }));
			await expect(
				runTickCommand(
					baseConfig({
						policyPath,
						botGrammarPath: grammarPath,
						warrenBaseUrl: "http://warren.test",
						dbPath: ":memory:",
					}),
					TICK_DEPS,
					{ campaign: "camp-x" },
				),
			).rejects.toThrow(ValidationError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
