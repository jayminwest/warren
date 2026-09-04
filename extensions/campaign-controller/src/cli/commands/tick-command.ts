/**
 * The `tick` command (warren-d050): one deterministic, bounded, restart-safe
 * dry-run reconciliation pass over one campaign.
 *
 * Configuration is explicit: DB path, repository-policy snapshot, summaries
 * file, and the Warren base URL come from flags or their named environment
 * variables; the Warren credential comes only from `WARREN_API_TOKEN` and
 * the optional GitHub credential only from `GITHUB_TOKEN`. There is no live
 * mode: the composed tick is dry-run by construction, `--dry-run` is the
 * default and only behavior, and a `--live` flag is refused as a usage error.
 */
import type { Clock, IdGenerator } from "../../clock.ts";
import { ConfigError } from "../../errors.ts";
import { ReadOnlyGithubClient } from "../../github/client.ts";
import type { FetchLike as GithubFetchLike } from "../../github/http-transport.ts";
import { BunFetchGithubTransport } from "../../github/http-transport.ts";
import { BunFetchGithubPrCreator } from "../../github/pr-create.ts";
import { validateBotGrammar } from "../../reconcile/bot-grammar.ts";
import { validateRepositoryPolicy } from "../../repository-policy.ts";
import { runTick } from "../../tick/tick.ts";
import type { FetchLike } from "../../warren-client.ts";
import { WarrenClient } from "../../warren-client.ts";
import {
	type CliConfig,
	ENV_POLICY_PATH,
	ENV_WARREN_API_TOKEN,
	ENV_WARREN_BASE_URL,
	requirePath,
} from "../config.ts";
import { CliError } from "../exit-codes.ts";
import { loadSummaries, openStore, readJsonFile } from "./shared.ts";

export interface TickCommandDeps {
	readonly clock: Clock;
	readonly ids: IdGenerator;
	/** Injectable warren fetch; production default is the global fetch. */
	readonly warrenFetch?: FetchLike;
	/** Injectable GitHub fetch; production default is the global fetch. */
	readonly githubFetch?: GithubFetchLike;
}

export async function runTickCommand(
	config: CliConfig,
	deps: TickCommandDeps,
	flags: Readonly<Record<string, string | true>>,
): Promise<Record<string, unknown>> {
	const campaignId = requireCampaignFlag(flags);
	if (config.warrenToken === null || config.warrenToken.length === 0) {
		throw new ConfigError(
			`missing warren credential: set ${ENV_WARREN_API_TOKEN} (the token enters only through that environment variable and is never echoed)`,
		);
	}
	if (config.warrenBaseUrl === null || config.warrenBaseUrl.length === 0) {
		throw new ConfigError(
			`missing warren base URL: pass --warren-url or set ${ENV_WARREN_BASE_URL}`,
		);
	}
	const policyPath = requirePath(config, "policyPath", "policy", ENV_POLICY_PATH);
	const policy = readJsonFile(policyPath, "repository policy");
	// The bot grammar is optional but fail-loud when configured (warren-8c83):
	// a bad path or an invalid grammar aborts the tick at startup instead of
	// silently disabling review-feedback classification.
	const botGrammar =
		config.botGrammarPath !== null && config.botGrammarPath.length > 0
			? validateBotGrammar(readJsonFile(config.botGrammarPath, "bot grammar"))
			: undefined;
	const summaries = loadSummaries(config.summariesPath);

	const store = openStore(config, deps.clock, deps.ids);
	try {
		const warrenClient = new WarrenClient({
			baseUrl: config.warrenBaseUrl,
			token: config.warrenToken,
			fetchFn: deps.warrenFetch,
			clock: deps.clock,
		});
		const transport = new BunFetchGithubTransport({
			baseUrl: config.githubBaseUrl ?? undefined,
			token: config.githubToken ?? undefined,
			fetchImpl: deps.githubFetch,
		});
		const github = new ReadOnlyGithubClient(transport);
		const prCreator = maybeBuildPrCreator(config, deps, policy);
		const result = await runTick(
			{
				store,
				warrenClient,
				github,
				clock: deps.clock,
				ids: deps.ids,
				policy,
				summaries,
				...(botGrammar !== undefined ? { botGrammar } : {}),
				...(prCreator !== undefined ? { prCreator } : {}),
			},
			campaignId,
		);
		return result as unknown as Record<string, unknown>;
	} finally {
		store.close();
	}
}

/**
 * The Phase 2 gate (warren-84da): the PR creator exists ONLY when the
 * validated repository policy enables `mutations.createPullRequest` AND a
 * GitHub credential is present. There is deliberately no flag for this —
 * the capability comes from the approved policy file, and `--live` stays a
 * usage error. An invalid policy fails the tick later, at admission, with
 * its own precise error; here it simply means no creator.
 */
function maybeBuildPrCreator(
	config: CliConfig,
	deps: TickCommandDeps,
	policy: unknown,
): BunFetchGithubPrCreator | undefined {
	if (config.githubToken === null || config.githubToken.length === 0) {
		return undefined;
	}
	let validated: ReturnType<typeof validateRepositoryPolicy>;
	try {
		validated = validateRepositoryPolicy(policy, { nowMs: deps.clock.nowMs() });
	} catch {
		return undefined;
	}
	if (validated.policy.mutations.createPullRequest !== true) {
		return undefined;
	}
	return new BunFetchGithubPrCreator({
		policy: validated.policy,
		baseUrl: config.githubBaseUrl ?? undefined,
		token: config.githubToken,
		fetchImpl: deps.githubFetch,
	});
}

function requireCampaignFlag(flags: Readonly<Record<string, string | true>>): string {
	const value = flags.campaign;
	if (typeof value !== "string" || value.length === 0) {
		throw new CliError("missing campaign id: pass --campaign <id>");
	}
	return value;
}
