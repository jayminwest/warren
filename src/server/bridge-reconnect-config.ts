/**
 * The per-project config resolver for the terminal-detect reap path,
 * extracted from `./bridge-reconnect.ts` to keep that file under the
 * file-size ratchet (warren-4553 / warren-9f06). It loads a run's owning
 * project `.warren/...` config ONCE and degrades every feature to
 * `undefined` (skip the sub-step) on any miss — the reap sub-steps gate on
 * their own field.
 */

import type { BoundBridgeLogger } from "../runs/index.ts";
import type { PrTemplateOverrides } from "../runs/pr-template.ts";
import type { ServerPreviewConfig } from "../warren-config/index.ts";
import type { AutoMergeConfig } from "../warren-config/pr-config.ts";
import type { RunWithReconnectInput } from "./bridge-reconnect.ts";

/**
 * The per-project config a SUCCEEDED run's reap needs: the preview launch
 * block (R-19), the PR-body template fragments (warren-bd49), and the
 * auto-merge arm's engagement gate (warren-14d6 / pl-92a3 step 6). Every
 * field is `undefined` when the project hasn't opted in or the
 * warren-config seam isn't wired (tests) — the matching reap sub-step
 * skips silently on its own field, so a project that opts into nothing
 * keeps byte-identical behavior.
 */
export interface SucceededReapProjectConfig {
	readonly previewConfig: ServerPreviewConfig | undefined;
	readonly prTemplate: PrTemplateOverrides | undefined;
	/** The project's own `pr.autoMerge` block — off is `undefined`, silent. */
	readonly prAutoMerge: AutoMergeConfig | undefined;
}

const NO_PROJECT_CONFIG: SucceededReapProjectConfig = {
	previewConfig: undefined,
	prTemplate: undefined,
	prAutoMerge: undefined,
};

/**
 * Resolve {@link SucceededReapProjectConfig} for the run the bridge just
 * observed reach terminal, loading the project's `.warren/` config once.
 * Loader errors (`malformed config.yaml`, a vanished clone) degrade every
 * field to `undefined` with one warn — operators see the underlying error
 * via the `/projects/:id/warren-config` route. The preview block needs the
 * port allocator too, and `type: 'static'` is a filed follow-up (per
 * docs/design/preview-environments.md), so a preview that cannot launch
 * reads as not-opted-in rather than promising a placeholder in the PR body.
 */
export async function resolveSucceededReapProjectConfig(
	input: RunWithReconnectInput,
	log: BoundBridgeLogger,
): Promise<SucceededReapProjectConfig> {
	if (input.warrenConfigs === undefined) return NO_PROJECT_CONFIG;
	const run = await input.repos.runs.get(input.runId);
	if (run === null || run.projectId === null) return NO_PROJECT_CONFIG;
	const project = await input.repos.projects.get(run.projectId);
	if (project === null) return NO_PROJECT_CONFIG;
	try {
		const config = await input.warrenConfigs.get(project.id, project.localPath);
		const preview = config.defaults?.preview;
		const template = config.prTemplate;
		return {
			previewConfig:
				input.portAllocator !== undefined && preview?.type === "server" ? preview : undefined,
			prTemplate:
				template !== null && template !== undefined && Object.keys(template).length > 0
					? template
					: undefined,
			prAutoMerge: config.defaults?.pr?.autoMerge,
		};
	} catch (err) {
		log.warn(
			{
				event: "bridge.reap_project_config_failed",
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"project config load failed; skipping preview, PR template, and auto-merge arm",
		);
		return NO_PROJECT_CONFIG;
	}
}
