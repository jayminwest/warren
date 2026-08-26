/**
 * `manifest validate` and `manifest import` commands (warren-d050).
 *
 * Both validate the manifest (and, when supplied, the repository-policy
 * snapshot) against the pinned clock. Import additionally persists the
 * immutable campaign through `importCampaign` — the single source of truth
 * for campaign creation — and returns its ordered work items.
 */
import { importCampaign } from "../../admission.ts";
import type { Clock, IdGenerator } from "../../clock.ts";
import { ValidationError } from "../../errors.ts";
import { validateCampaignManifest } from "../../manifest.ts";
import { validateRepositoryPolicy } from "../../repository-policy.ts";
import { type CliConfig, ENV_MANIFEST_PATH, ENV_POLICY_PATH, requirePath } from "../config.ts";
import { campaignToJson, openStore, readJsonFile, workItemToJson } from "./shared.ts";

export interface ManifestCommandDeps {
	readonly clock: Clock;
}

export function runManifestValidate(
	config: CliConfig,
	deps: ManifestCommandDeps,
): Record<string, unknown> {
	const manifestPath = requirePath(config, "manifestPath", "manifest", ENV_MANIFEST_PATH);
	const nowMs = deps.clock.nowMs();
	const validated = validateCampaignManifest(readJsonFile(manifestPath, "manifest"), { nowMs });
	let policyDigest: string | null = null;
	if (config.policyPath !== null) {
		const policy = validateRepositoryPolicy(readJsonFile(config.policyPath, "policy"), { nowMs });
		if (
			policy.policy.upstream.owner !== validated.manifest.upstream.owner ||
			policy.policy.upstream.repo !== validated.manifest.upstream.repo
		) {
			throw new ValidationError(
				`repository policy upstream ${policy.policy.upstream.owner}/${policy.policy.upstream.repo} does not match manifest upstream ${validated.manifest.upstream.owner}/${validated.manifest.upstream.repo}`,
			);
		}
		policyDigest = policy.digest;
	}
	return {
		campaignId: validated.manifest.campaignId,
		manifestDigest: validated.digest,
		policyDigest,
		issues: validated.manifest.issues,
		expiresAt: validated.manifest.expiresAt,
		promptBound: validated.manifest.prompt !== undefined,
	};
}

export function runManifestImport(
	config: CliConfig,
	deps: { clock: Clock; ids: IdGenerator },
): Record<string, unknown> {
	const manifestPath = requirePath(config, "manifestPath", "manifest", ENV_MANIFEST_PATH);
	const policyPath = requirePath(config, "policyPath", "policy", ENV_POLICY_PATH);
	const nowMs = deps.clock.nowMs();
	const manifestInput = readJsonFile(manifestPath, "manifest");
	const policyInput = readJsonFile(policyPath, "policy");
	const store = openStore(config, deps.clock, deps.ids);
	try {
		const imported = importCampaign(store, { manifest: manifestInput, policy: policyInput, nowMs });
		return {
			campaign: campaignToJson(imported.campaign),
			manifestDigest: imported.manifestDigest,
			policyDigest: imported.policyDigest,
			invalidatedPriorVersions: imported.invalidatedPriorVersions,
			workItems: imported.workItems.map(workItemToJson),
		};
	} finally {
		store.close();
	}
}
