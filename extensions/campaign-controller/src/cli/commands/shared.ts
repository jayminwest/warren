/**
 * Shared command plumbing: file reading, store opening, row projections
 * (warren-d050). Every projection returns a JSON-safe, secret-free shape.
 */
import * as fs from "node:fs";
import type { Clock, IdGenerator } from "../../clock.ts";
import { ConfigError, ValidationError } from "../../errors.ts";
import type { PrIntentSummaryFacts } from "../../pr-intent/intender.ts";
import { CampaignStateStore } from "../../store/state-store.ts";
import type {
	ActionRow,
	AttentionItemRow,
	CampaignRow,
	PrIdentityRow,
	WorkItemRow,
} from "../../store/types.ts";
import type { CliConfig } from "../config.ts";
import { ENV_DB_PATH, requirePath } from "../config.ts";

/** Read and parse one JSON file. Missing/unreadable is config; bad JSON is input. */
export function readJsonFile(path: string, what: string): unknown {
	let text: string;
	try {
		text = fs.readFileSync(path, "utf8");
	} catch (cause) {
		throw new ConfigError(`cannot read the ${what} file at ${path}`, { cause });
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (cause) {
		throw new ValidationError(`the ${what} file at ${path} is not valid JSON`, { cause });
	}
}

/** Open the durable state store at the configured DB path. */
export function openStore(config: CliConfig, clock: Clock, ids: IdGenerator): CampaignStateStore {
	const dbPath = requirePath(config, "dbPath", "db", ENV_DB_PATH);
	return new CampaignStateStore(dbPath, { clock, ids });
}

/**
 * Load the optional operator summaries file: issue number (as a JSON object
 * key) → change summary. Entries are not eagerly validated — the PR-intent
 * renderer refuses an incomplete summary fail-closed with its invariant.
 */
export function loadSummaries(path: string | null): Map<number, PrIntentSummaryFacts> {
	const summaries = new Map<number, PrIntentSummaryFacts>();
	if (path === null) {
		return summaries;
	}
	const raw = readJsonFile(path, "summaries");
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new ValidationError(
			`the summaries file at ${path} must be a JSON object keyed by issue number`,
		);
	}
	for (const [key, value] of Object.entries(raw)) {
		const issueNumber = Number(key);
		if (!Number.isInteger(issueNumber) || issueNumber < 1) {
			throw new ValidationError(
				`the summaries file at ${path} has a non-issue key '${key}' — keys are issue numbers`,
			);
		}
		summaries.set(issueNumber, value as PrIntentSummaryFacts);
	}
	return summaries;
}

export function campaignToJson(campaign: CampaignRow): Record<string, unknown> {
	return {
		id: campaign.id,
		status: campaign.status,
		manifestDigest: campaign.manifestDigest,
		policyDigest: campaign.policyDigest,
		budgetCapUsdCents: campaign.budgetCapUsdCents,
		approvedAtMs: campaign.approvedAtMs,
		createdAtMs: campaign.createdAtMs,
	};
}

export function workItemToJson(item: WorkItemRow): Record<string, unknown> {
	return {
		id: item.id,
		campaignId: item.campaignId,
		position: item.position,
		issueRef: item.issueRef,
		status: item.status,
		createdAtMs: item.createdAtMs,
		updatedAtMs: item.updatedAtMs,
	};
}

export function actionToJson(action: ActionRow): Record<string, unknown> {
	return {
		id: action.id,
		actionKey: action.actionKey,
		campaignId: action.campaignId,
		workItemId: action.workItemId,
		actionType: action.actionType,
		state: action.state,
		attempt: action.attempt,
		requestDigest: action.requestDigest,
		policyDigest: action.policyDigest,
		reservedUsdCents: action.reservedUsdCents,
		startedAtMs: action.startedAtMs,
		settledAtMs: action.settledAtMs,
		resultRunId: action.resultRunId,
		resultBranch: action.resultBranch,
		resultPrNumber: action.resultPrNumber,
		errorClass: action.errorClass,
		errorJson: action.errorJson,
		createdAtMs: action.createdAtMs,
	};
}

export function attentionToJson(item: AttentionItemRow): Record<string, unknown> {
	return {
		id: item.id,
		campaignId: item.campaignId,
		workItemId: item.workItemId,
		reason: item.reason,
		detailJson: item.detailJson,
		createdAtMs: item.createdAtMs,
		resolvedAtMs: item.resolvedAtMs,
	};
}

export function prIdentityToJson(identity: PrIdentityRow): Record<string, unknown> {
	return {
		id: identity.id,
		campaignId: identity.campaignId,
		workItemId: identity.workItemId,
		upstream: `${identity.upstreamOwner}/${identity.upstreamRepo}`,
		fork: `${identity.forkOwner}/${identity.forkRepo}`,
		headBranch: identity.headBranch,
		title: identity.title,
		bodyDigest: identity.bodyDigest,
		prNumber: identity.prNumber,
		createdAtMs: identity.createdAtMs,
	};
}
