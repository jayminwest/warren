/**
 * `amendment validate` and `amendment apply` commands (warren-35c4).
 *
 * Both validate the amendment document against the pinned clock. Apply
 * additionally persists the amendment through `applyAmendment` — the
 * single source of truth for the in-place version bump — and returns the
 * new manifest digest plus the appended work items. A clean amendment
 * never spawns a superseded campaign row or a superseded attention item.
 */

import { applyAmendment, validateCampaignAmendment } from "../../amendment.ts";
import type { Clock, IdGenerator } from "../../clock.ts";
import { type CliConfig, ENV_AMENDMENT_PATH, requirePath } from "../config.ts";
import { openStore, readJsonFile, workItemToJson } from "./shared.ts";

export interface AmendmentCommandDeps {
	readonly clock: Clock;
	readonly ids: IdGenerator;
}

export function runAmendmentValidate(
	config: CliConfig,
	deps: AmendmentCommandDeps,
): Record<string, unknown> {
	const validated = readAndValidateAmendment(config, deps.clock.nowMs());
	const { amendment, digest } = validated;
	return {
		amendmentId: amendment.amendmentId,
		campaignId: amendment.campaignId,
		baseManifestDigest: amendment.baseManifestDigest,
		amendmentDigest: digest,
		appendIssues: amendment.appendIssues ?? [],
	};
}

/** Read the amendment file from config and validate it against `nowMs`. */
function readAndValidateAmendment(config: CliConfig, nowMs: number) {
	const amendmentPath = requirePath(config, "amendmentPath", "amendment", ENV_AMENDMENT_PATH);
	return validateCampaignAmendment(readJsonFile(amendmentPath, "amendment"), { nowMs });
}

export function runAmendmentApply(
	config: CliConfig,
	deps: AmendmentCommandDeps,
): Record<string, unknown> {
	const nowMs = deps.clock.nowMs();
	const amendmentInput = readAndValidateAmendment(config, nowMs);
	const store = openStore(config, deps.clock, deps.ids);
	try {
		const applied = applyAmendment(store, { amendment: amendmentInput, nowMs });
		return {
			campaignId: applied.campaign.id,
			applied: applied.applied,
			manifestDigest: applied.manifestDigest,
			campaignVersion: (JSON.parse(applied.campaign.manifestJson) as { campaignVersion: number })
				.campaignVersion,
			amendedFields: applied.amendedFields,
			appendedIssues: applied.appendedIssues,
			invalidatedActionIds: applied.invalidatedActionIds,
			appendedWorkItems: applied.appendedWorkItems.map(workItemToJson),
		};
	} finally {
		store.close();
	}
}
