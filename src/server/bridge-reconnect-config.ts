/**
 * Per-project config resolvers for the terminal-detect reap path,
 * extracted from `./bridge-reconnect.ts` to keep that file under the
 * file-size ratchet (warren-4553 / warren-9f06). Both load a run's owning
 * project `.warren/...` config and degrade to `undefined` (skip the
 * feature) on any miss — the reap sub-step gates on the result.
 */

import type { BoundBridgeLogger } from "../runs/index.ts";
import type { PrTemplateOverrides } from "../runs/pr-template.ts";
import type { ServerPreviewConfig } from "../warren-config/index.ts";
import type { RunWithReconnectInput } from "./bridge-reconnect.ts";

/**
 * Resolve the project's `.warren/defaults.json` preview block (R-19) for
 * the run the bridge just observed reach terminal. Returns `undefined`
 * when the project hasn't opted in or when the warren-config seam isn't
 * wired (tests that omit `warrenConfigs`/`portAllocator`). The launcher
 * gate inside reap is what skips the actual preview spawn when this
 * function returns `undefined`. Loader errors (`malformed defaults.json`,
 * etc.) also return `undefined` — operators see the underlying error via
 * the `/projects/:id/warren-config` route.
 */
export async function resolveProjectPreviewConfig(
	input: RunWithReconnectInput,
	log: BoundBridgeLogger,
): Promise<ServerPreviewConfig | undefined> {
	if (input.warrenConfigs === undefined || input.portAllocator === undefined) return undefined;
	const run = await input.repos.runs.get(input.runId);
	if (run === null || run.projectId === null) return undefined;
	const project = await input.repos.projects.get(run.projectId);
	if (project === null) return undefined;
	try {
		const config = await input.warrenConfigs.get(project.id, project.localPath);
		const preview = config.defaults?.preview;
		if (preview === undefined) return undefined;
		// `type: 'static'` is filed as a follow-up (per SPEC §11.L); reap
		// would reject at launch time anyway. Skip cleanly here so the
		// PR-body placeholder doesn't promise a preview that can't run.
		if (preview.type !== "server") return undefined;
		return preview;
	} catch (err) {
		log.warn(
			{
				event: "bridge.preview_config_failed",
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview config load failed; skipping preview launch",
		);
		return undefined;
	}
}

/**
 * Resolve the project's `.warren/pr-template.md` fragment overrides
 * (warren-bd49) for the run the bridge just observed reach terminal.
 * Returns `undefined` when the project ships no template, when the
 * warren-config seam isn't wired (tests), or when the parsed envelope
 * has no overrides. Loader errors fall through to `undefined` so reap
 * uses the built-in defaults; operators see the underlying error via
 * `/projects/:id/warren-config`.
 */
export async function resolveProjectPrTemplate(
	input: RunWithReconnectInput,
	log: BoundBridgeLogger,
): Promise<PrTemplateOverrides | undefined> {
	if (input.warrenConfigs === undefined) return undefined;
	const run = await input.repos.runs.get(input.runId);
	if (run === null || run.projectId === null) return undefined;
	const project = await input.repos.projects.get(run.projectId);
	if (project === null) return undefined;
	try {
		const config = await input.warrenConfigs.get(project.id, project.localPath);
		const overrides = config.prTemplate;
		if (overrides === null || overrides === undefined) return undefined;
		if (Object.keys(overrides).length === 0) return undefined;
		return overrides;
	} catch (err) {
		log.warn(
			{
				event: "bridge.pr_template_failed",
				projectId: project.id,
				err: err instanceof Error ? err.message : String(err),
			},
			"pr-template load failed; falling back to built-in defaults",
		);
		return undefined;
	}
}
