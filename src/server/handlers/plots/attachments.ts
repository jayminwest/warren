/**
 * Plot attachment handlers — attach / detach / merge-PR
 * (warren-332b / pl-369d).
 *
 *   - `POST   /plots/:id/attachments`
 *   - `DELETE /plots/:id/attachments/:ref`
 *   - `POST   /plots/:id/attachments/:ref/merge`
 *
 * Extracted from `src/server/handlers/plots.ts`. Resolve-project +
 * envelope assembly live in `./shared.ts`.
 */

import { join } from "node:path";
import { ATTACHMENT_TYPES, type AttachmentType } from "@os-eco/plot-cli";
import { ValidationError } from "../../../core/errors.ts";
import { defaultPlotAttacher, defaultPlotPrMerger } from "../../../plots/index.ts";
import { refreshProject } from "../../../projects/index.ts";
import { resolveDispatcherHandle } from "../../../runs/index.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import {
	defaultSpawn,
	optionalString,
	readJsonBody,
	readJsonBodyOrEmpty,
	requireParam,
} from "../index.ts";
import {
	buildPlotEnvelope,
	loadPausedRunsForPlot,
	plotProjectionForProject,
	resolvePlotProject,
} from "./shared.ts";

/**
 * Per-kind ref-shape patterns enforced at the handler edge (warren-589c).
 *
 * The lib only checks `ref.minLength >= 1`. Warren narrows this further
 * so typos / wrong-kind refs reject before the disk round-trip. Kinds
 * without a defined pattern fall through to the lib's min-length check.
 *
 * SPEC §3.1 leaves `ref` free-form, but the conventional shapes are
 * tractable:
 *   - `seeds_issue`  → `<project>-<4 hex>` (seeds id format).
 *   - `mulch_record` → `mx-<6 hex>` (mulch record id format).
 *   - `agent_run`    → `run-<...>` (warren run id format, prefix
 *                                      check only — the suffix shape
 *                                      varies across deployments).
 *   - `gh_pr`        → free-form (PRs use full URLs / owner/repo#N).
 *   - `gh_issue`     → free-form (same).
 *   - `file`         → free-form (paths are arbitrary).
 */
const ATTACHMENT_REF_PATTERNS: Partial<Record<AttachmentType, RegExp>> = {
	seeds_issue: /^[a-z0-9_-]+-[a-f0-9]{4}$/,
	mulch_record: /^mx-[a-f0-9]{6}$/,
	agent_run: /^run-[A-Za-z0-9_-]+$/,
};

/**
 * `POST /plots/:id/attachments` — attach an external reference to a
 * Plot (warren-589c / pl-9d6a step 11).
 *
 * Handler order:
 *   (1) parse + validate `kind` against `ATTACHMENT_TYPES` (the lib's
 *       enum); per-kind ref shape is then validated via
 *       `ATTACHMENT_REF_PATTERNS`.
 *   (2) parse + validate `ref` (non-empty string) and the optional
 *       `role` (non-empty string when present).
 *   (3) resolve the dispatcher handle via `resolveDispatcherHandle`
 *       (mx-6a9788) — malformed/empty input downgrades to `operator`.
 *   (4) resolve the owning project (`resolvePlotProject`; `null` /
 *       unwired resolver → 404, `hasPlot=false` → 400).
 *   (5) hand off to `deps.plotAttacher` (default `defaultPlotAttacher`)
 *       which opens a `UserPlotClient` and calls `PlotHandle.attach`.
 *       Failure propagates synchronously — NOT fire-and-log.
 *   (6) invalidate the aggregator cache entry for the project so a
 *       follow-up `GET /plots` sees the new `attachments_count`
 *       without the 5s TTL wait.
 *   (7) return 200 with `{ envelope: PlotEnvelope, attachment: Attachment }`
 *       so the UI can splice the new attachment into its optimistic
 *       state without re-rendering the entire envelope.
 *
 * ACL note: `UserPlotClient` exclusively (via the attacher seam).
 */
/**
 * Parse + validate the `{kind, ref, role?}` body of `POST .../attachments`.
 * `kind` must be a known `ATTACHMENT_TYPES` member; `ref` is non-empty and,
 * for kinds with a defined pattern, must match `ATTACHMENT_REF_PATTERNS`;
 * `role` (optional) is a non-empty string when present.
 */
function parseAttachmentBody(body: Record<string, unknown>): {
	kind: AttachmentType;
	ref: string;
	role?: string;
} {
	const rawKind = body.kind;
	if (typeof rawKind !== "string") {
		throw new ValidationError("field 'kind' must be a string");
	}
	if (!(ATTACHMENT_TYPES as readonly string[]).includes(rawKind)) {
		throw new ValidationError(
			`kind must be one of ${ATTACHMENT_TYPES.join(", ")}; got '${rawKind}'`,
		);
	}
	const kind = rawKind as AttachmentType;

	const rawRef = body.ref;
	if (typeof rawRef !== "string" || rawRef.length === 0) {
		throw new ValidationError("field 'ref' must be a non-empty string");
	}
	const refPattern = ATTACHMENT_REF_PATTERNS[kind];
	if (refPattern !== undefined && !refPattern.test(rawRef)) {
		throw new ValidationError(
			`field 'ref' does not match the expected shape for kind '${kind}' (pattern: ${refPattern.source})`,
		);
	}
	if (body.role !== undefined) {
		if (typeof body.role !== "string" || body.role.length === 0) {
			throw new ValidationError("field 'role' must be a non-empty string when present");
		}
		return { kind, ref: rawRef, role: body.role };
	}
	return { kind, ref: rawRef };
}

function attachPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const dispatcherHandle = optionalString(body, "dispatcher_handle");

		const { kind, ref, role } = parseAttachmentBody(body);

		const handle = resolveDispatcherHandle(dispatcherHandle);
		const project = await resolvePlotProject(deps, plotId, "attach to plot");

		const attacher = deps.plotAttacher ?? defaultPlotAttacher;
		const result = await attacher.attach({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			kind,
			ref,
			...(role !== undefined ? { role } : {}),
			projection: plotProjectionForProject(deps, project.id),
		});

		deps.plotAggregator?.invalidate(project.id);

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		return jsonResponse(200, {
			envelope: buildPlotEnvelope(result, project.id, paused_runs),
			attachment: result.attachment,
		});
	};
}

/**
 * `DELETE /plots/:id/attachments/:ref` — detach an external reference
 * from a Plot (warren-589c / pl-9d6a step 11).
 *
 * Handler order:
 *   (1) decode the `:ref` URL param and reject empty refs at the edge.
 *   (2) parse the optional `dispatcher_handle` from the request body
 *       (DELETE bodies are spec-legal under fetch and Bun.serve).
 *   (3) resolve the dispatcher handle via `resolveDispatcherHandle`.
 *   (4) resolve the owning project (`resolvePlotProject`).
 *   (5) hand off to `deps.plotAttacher.detach` (default
 *       `defaultPlotAttacher`) which reads the Plot, maps the ref to
 *       the lib's `att-NNN` id, and calls `PlotHandle.detach`.
 *       `PlotAttachmentNotFoundError` (404) surfaces when the ref
 *       doesn't match any current attachment.
 *   (6) invalidate the aggregator cache entry for the project.
 *   (7) return 200 with `{ envelope: PlotEnvelope, removed_id }`.
 */
function detachPlotHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const ref = requireParam(ctx, "ref");
		if (ref.length === 0) {
			throw new ValidationError("path param ':ref' must be a non-empty string");
		}

		// DELETE bodies are rare — readJsonBodyOrEmpty returns null for empty
		// payloads so the call stays optional.
		const body = await readJsonBodyOrEmpty(ctx);
		const dispatcherHandle = body !== null ? optionalString(body, "dispatcher_handle") : undefined;

		const handle = resolveDispatcherHandle(dispatcherHandle);
		const project = await resolvePlotProject(deps, plotId, "detach from plot");

		const attacher = deps.plotAttacher ?? defaultPlotAttacher;
		const result = await attacher.detach({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			ref,
			projection: plotProjectionForProject(deps, project.id),
		});

		deps.plotAggregator?.invalidate(project.id);

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		return jsonResponse(200, {
			envelope: buildPlotEnvelope(result, project.id, paused_runs),
			removed_id: result.removed_id,
		});
	};
}

/**
 * `POST /plots/:id/attachments/:ref/merge` — click-to-merge a
 * GitHub PR attachment (warren-8e39 / pl-0344 step 14).
 *
 * Handler order:
 *   (1) decode `:ref` (router runs decodeURIComponent) and reject
 *       empty refs at the edge.
 *   (2) optional body parses `dispatcher_handle` + `merge_method`
 *       (‘merge’ | ‘squash’ | ‘rebase’, default ‘merge’).
 *   (3) handle resolution via `resolveDispatcherHandle`.
 *   (4) resolve owning project (`resolvePlotProject`).
 *   (5) `deps.plotPrMerger.merge` resolves the gh_pr attachment,
 *       parses the ref, calls `mergePullRequest` against the GitHub
 *       REST API, and returns the post-merge Plot snapshot + the
 *       `MergePullRequestResult` variant. Errors:
 *         - `PlotAttachmentNotFoundError` (404) — unknown ref
 *         - `PlotPrAttachmentMismatchedKindError` (400) — wrong kind
 *         - `PlotPrAttachmentInvalidError` (400) — unparseable ref
 *   (6) on `merge.kind === "merged" | "already_merged"` schedule a
 *       background `refreshProject` so the local clone picks up the
 *       new merge commit. Fire-and-forget — the wire response does NOT
 *       block on the refresh.
 *   (7) invalidate the aggregator cache entry for the project.
 *   (8) return 200 with `{ envelope, merge, attachment_id,
 *       refresh_scheduled }`. The `merge` variant is surfaced verbatim.
 *
 * GitHub auth: `deps.autoOpenPr.token` carries `GITHUB_TOKEN` (same
 * source the reap path uses for PR open). Tokenless deployments surface
 * `merge.kind === "missing_token"` so the UI can hint the operator.
 */
const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
type MergeMethod = (typeof MERGE_METHODS)[number];

/** Parse + validate the optional `merge_method` field (default `merge`). */
function parseMergeMethod(body: Record<string, unknown> | null): MergeMethod | undefined {
	if (body === null || body.merge_method === undefined) return undefined;
	const raw = body.merge_method;
	if (typeof raw !== "string" || !(MERGE_METHODS as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`merge_method must be one of ${MERGE_METHODS.join(", ")}; got '${raw}'`,
		);
	}
	return raw as MergeMethod;
}

function mergePlotPrAttachmentHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const plotId = requireParam(ctx, "id");
		const ref = requireParam(ctx, "ref");
		if (ref.length === 0) {
			throw new ValidationError("path param ':ref' must be a non-empty string");
		}

		const body = await readJsonBodyOrEmpty(ctx);
		const dispatcherHandle = body !== null ? optionalString(body, "dispatcher_handle") : undefined;
		const mergeMethod = parseMergeMethod(body);

		const handle = resolveDispatcherHandle(dispatcherHandle);
		const project = await resolvePlotProject(deps, plotId, "merge attachment on plot");

		const merger = deps.plotPrMerger ?? defaultPlotPrMerger;
		const token = deps.autoOpenPr?.token ?? "";
		const result = await merger.merge({
			plotDir: join(project.localPath, ".plot"),
			plotId,
			handle,
			ref,
			token,
			...(mergeMethod !== undefined ? { mergeMethod } : {}),
		});

		let refreshScheduled = false;
		if (result.merge.kind === "merged" || result.merge.kind === "already_merged") {
			refreshScheduled = true;
			scheduleRefreshAfterMerge(deps, project.id, plotId, ref);
		}

		deps.plotAggregator?.invalidate(project.id);

		const paused_runs = await loadPausedRunsForPlot(deps, plotId, project);
		return jsonResponse(200, {
			envelope: buildPlotEnvelope(result, project.id, paused_runs),
			merge: result.merge,
			attachment_id: result.attachment_id,
			refresh_scheduled: refreshScheduled,
		});
	};
}

/**
 * Fire-and-forget background refresh so the local clone picks up the new
 * merge commit. The user already has the merge outcome on the response;
 * this is a follow-up sync logged on completion/failure.
 */
function scheduleRefreshAfterMerge(
	deps: ServerDeps,
	projectId: string,
	plotId: string,
	ref: string,
): void {
	void refreshProject({
		repo: deps.repos.projects,
		config: deps.projectsConfig,
		id: projectId,
		spawn: deps.spawn ?? defaultSpawn,
		...(deps.now !== undefined ? { now: deps.now } : {}),
		...(deps.warrenConfigs !== undefined ? { warrenConfigs: deps.warrenConfigs } : {}),
	})
		.then((res) => {
			deps.logger.info(
				{ projectId, headSha: res.headSha, plotId, ref },
				"background project refresh after PR merge",
			);
		})
		.catch((err: unknown) => {
			deps.logger.warn(
				{
					projectId,
					plotId,
					ref,
					err: err instanceof Error ? err.message : String(err),
				},
				"background project refresh after PR merge failed",
			);
		});
}

export { attachPlotHandler, detachPlotHandler, mergePlotPrAttachmentHandler };
