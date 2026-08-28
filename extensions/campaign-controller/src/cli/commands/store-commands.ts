/**
 * `approve`, `status`, `journal`, and `attention` commands (warren-d050).
 *
 * All of them are thin, read-only projections over the durable store plus
 * the single-source-of-truth domain functions: approval goes through
 * `approveCampaign`, attention acknowledgment through `resolveAttention`.
 * None of them performs network I/O, so they need no credential at all.
 */
import { approveCampaign } from "../../admission.ts";
import type { Clock, IdGenerator } from "../../clock.ts";
import { StateError } from "../../errors.ts";
import { buildCampaignReport } from "../../report/report.ts";
import type { CampaignStateStore } from "../../store/state-store.ts";
import type { CliConfig } from "../config.ts";
import { CliError } from "../exit-codes.ts";
import {
	actionToJson,
	attentionToJson,
	campaignToJson,
	openStore,
	prIdentityToJson,
	workItemToJson,
} from "./shared.ts";

export interface StoreCommandDeps {
	readonly clock: Clock;
	readonly ids: IdGenerator;
}

/** Open the store, run `fn`, always close: one lifecycle per command. */
function withStore<T>(
	config: CliConfig,
	deps: StoreCommandDeps,
	fn: (store: CampaignStateStore) => T,
): T {
	const store = openStore(config, deps.clock, deps.ids);
	try {
		return fn(store);
	} finally {
		store.close();
	}
}

/** `withStore` plus the campaign-existence gate the scoped commands share. */
function campaignScoped<T>(
	config: CliConfig,
	deps: StoreCommandDeps,
	campaignId: string,
	fn: (store: CampaignStateStore) => T,
): T {
	return withStore(config, deps, (store) => {
		requireCampaign(store, campaignId);
		return fn(store);
	});
}

export function runApprove(
	config: CliConfig,
	deps: StoreCommandDeps,
	flags: Readonly<Record<string, string | true>>,
): Record<string, unknown> {
	const digest = requireStringFlag(flags, "digest");
	const approvedBy = requireStringFlag(flags, "by");
	const campaignId = requireStringFlag(flags, "campaign");
	return withStore(config, deps, (store) => {
		const approval = approveCampaign(store, {
			campaignId,
			manifestDigest: digest,
			approvedBy,
			nowMs: deps.clock.nowMs(),
		});
		return {
			campaignId: approval.campaign.id,
			manifestDigest: approval.manifestDigest,
			approvedBy: approval.approvedBy,
			approvedAtMs: approval.approvedAtMs,
			expiresAt: approval.expiresAt,
			status: approval.campaign.status,
		};
	});
}

export function runStatus(
	config: CliConfig,
	deps: StoreCommandDeps,
	flags: Readonly<Record<string, string | true>>,
): Record<string, unknown> {
	const { campaignId, workItemId } = scopeFlags(flags);
	return withStore(config, deps, (store) => {
		if (campaignId === null) {
			return { campaigns: store.campaigns.listCampaigns().map(campaignToJson) };
		}
		requireCampaign(store, campaignId);
		if (workItemId !== null) {
			return workItemStatus(store, campaignId, workItemId);
		}
		return campaignStatus(store, campaignId);
	});
}

export function runJournal(
	config: CliConfig,
	deps: StoreCommandDeps,
	flags: Readonly<Record<string, string | true>>,
): Record<string, unknown> {
	const { campaignId, workItemId } = scopeFlags(flags);
	return withStore(config, deps, (store) => {
		const actions =
			workItemId !== null
				? store.actions.listActionsForWorkItem(workItemId)
				: campaignId !== null
					? store.actions.listActionsForCampaign(campaignId)
					: store.actions.listAllActions();
		return { actions: actions.map(actionToJson) };
	});
}

export function runAttentionList(
	config: CliConfig,
	deps: StoreCommandDeps,
	flags: Readonly<Record<string, string | true>>,
): Record<string, unknown> {
	const campaignId = requireStringFlag(flags, "campaign");
	const includeResolved = flags.all === true;
	return campaignScoped(config, deps, campaignId, (store) => ({
		campaignId,
		items: store.events.listAttention(campaignId, includeResolved).map(attentionToJson),
	}));
}

export function runAttentionAck(
	config: CliConfig,
	deps: StoreCommandDeps,
	flags: Readonly<Record<string, string | true>>,
): Record<string, unknown> {
	const campaignId = requireStringFlag(flags, "campaign");
	const id = requireStringFlag(flags, "id");
	return campaignScoped(config, deps, campaignId, (store) => {
		const item = store.events.getAttentionItem(id);
		if (item === null || item.campaignId !== campaignId) {
			throw new StateError(`attention item ${id} does not belong to campaign ${campaignId}`);
		}
		store.events.resolveAttention(id);
		return {
			id,
			campaignId,
			resolvedAtMs: deps.clock.nowMs(),
			reason: item.reason,
		};
	});
}

/** The shared `--campaign` / `--work-item` scoping of status and journal. */
function scopeFlags(flags: Readonly<Record<string, string | true>>): {
	campaignId: string | null;
	workItemId: string | null;
} {
	return {
		campaignId: optionalStringFlag(flags, "campaign"),
		workItemId: optionalStringFlag(flags, "work-item"),
	};
}

function campaignStatus(store: CampaignStateStore, campaignId: string): Record<string, unknown> {
	return {
		campaign: campaignToJson(requireCampaign(store, campaignId)),
		workItems: store.campaigns.listWorkItems(campaignId).map(workItemToJson),
		prIdentities: store.events.listPrIdentities(campaignId).map(prIdentityToJson),
		budget: {
			capUsdCents: store.campaigns.getCampaign(campaignId)?.budgetCapUsdCents ?? null,
			availableUsdCents: store.budget.availableUsdCents(campaignId),
		},
		openAttention: store.events.listOpenAttention(campaignId).length,
		report: buildCampaignReport(store, campaignId),
	};
}

function workItemStatus(
	store: CampaignStateStore,
	campaignId: string,
	workItemId: string,
): Record<string, unknown> {
	const item = store.campaigns.getWorkItem(workItemId);
	if (item === null || item.campaignId !== campaignId) {
		throw new StateError(`work item ${workItemId} does not belong to campaign ${campaignId}`);
	}
	return {
		workItem: workItemToJson(item),
		actions: store.actions.listActionsForWorkItem(workItemId).map(actionToJson),
	};
}

function requireCampaign(store: CampaignStateStore, campaignId: string) {
	const campaign = store.campaigns.getCampaign(campaignId);
	if (campaign === null) {
		throw new StateError(`unknown campaign: ${campaignId}`);
	}
	return campaign;
}

function requireStringFlag(flags: Readonly<Record<string, string | true>>, name: string): string {
	const value = flags[name];
	if (typeof value !== "string" || value.length === 0) {
		throw new CliError(`missing required flag --${name}`);
	}
	return value;
}

function optionalStringFlag(
	flags: Readonly<Record<string, string | true>>,
	name: string,
): string | null {
	const value = flags[name];
	if (value === undefined) {
		return null;
	}
	if (typeof value !== "string" || value.length === 0) {
		throw new CliError(`flag --${name} requires a value`);
	}
	return value;
}
