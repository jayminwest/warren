/**
 * Shell-out facade to the seeds CLI (`sd`) for extension reads/writes.
 *
 * Two operations live here today:
 *
 *   `listScheduledSeeds` — `sd list --format json` against a project's
 *      .seeds/ directory, then filter to open issues with a parseable
 *      `extensions.scheduledFor`. The scheduler decides past-vs-future.
 *
 *   `clearScheduledFor`  — `sd update <id> --extensions <json>` to move
 *      `scheduledFor → lastScheduledRun` after a successful dispatch.
 *      pl-2f15 risk #4 mitigation: the warren-side `triggers.last_fired_at`
 *      gets stamped BEFORE this call, so a failure here doesn't cause
 *      double-dispatch on the next tick (the trigger row is already
 *      consistent). Callers surface the failure as a system event on the
 *      dispatched run so the operator sees the lingering extension.
 *
 * Both shell out via the injectable `SpawnFn` shape the rest of warren
 * uses (mx-371491). The `sd` cwd is the project clone root — seeds
 * resolves `.seeds/` relative to cwd, so we never construct that path
 * ourselves.
 */

import type { SpawnFn } from "../projects/clone.ts";
import { SeedsCliError } from "./errors.ts";
import {
	type ParseScheduledSeedsResult,
	parseScheduledSeeds,
	SeedsListEnvelopeSchema,
} from "./schema.ts";
import { DEFAULT_SD_TIMEOUT_MS, truncate } from "./util.ts";
import { type WarrenExtensions, WarrenExtensionsSchema } from "./warren-extensions.ts";

export interface SeedsCliDeps {
	readonly sdBinary: string;
	readonly spawn: SpawnFn;
	readonly timeoutMs?: number;
}

/**
 * Resolve the scheduled-for seeds for a single project. The caller (the
 * tick loop) filters down to `scheduledFor <= now` and decides what to
 * dispatch.
 */
export async function listScheduledSeeds(
	deps: SeedsCliDeps,
	projectPath: string,
): Promise<ParseScheduledSeedsResult> {
	const result = await deps.spawn([deps.sdBinary, "list", "--format", "json"], {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new SeedsCliError(
			`sd list exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
			{
				recoveryHint: `run \`${deps.sdBinary} doctor\` in ${projectPath} to diagnose`,
			},
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		throw new SeedsCliError(`sd list returned non-JSON output: ${formatError(err)}`, {
			cause: err,
		});
	}

	const envelope = SeedsListEnvelopeSchema.safeParse(parsed);
	if (!envelope.success) {
		throw new SeedsCliError(
			`sd list response did not match expected envelope: ${envelope.error.issues
				.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
				.join("; ")}`,
		);
	}

	return parseScheduledSeeds(envelope.data);
}

/**
 * Close a seed via `sd close <seedId>`. Best-effort — a non-zero exit is
 * wrapped in `SeedsCliError` so callers can surface it as a reap failure
 * rather than a fatal error. Seeds treats closing an already-closed seed
 * as a no-op success (idempotent).
 */
export async function closeSeed(
	deps: SeedsCliDeps,
	projectPath: string,
	seedId: string,
): Promise<void> {
	const result = await deps.spawn([deps.sdBinary, "close", seedId], {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new SeedsCliError(
			`sd close ${seedId} exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
		);
	}
}

/**
 * Move `scheduledFor → lastScheduledRun` on a seed via the seeds CLI's
 * extension-merge surface. Seeds' shallow-merge semantics treat `null` as
 * a clear, so writing `{scheduledFor: null, lastScheduledRun: runId}` in
 * one call leaves the seed in the post-fire state.
 */
export async function clearScheduledFor(
	deps: SeedsCliDeps,
	projectPath: string,
	seedId: string,
	runId: string,
): Promise<void> {
	await updateExtensions(deps, projectPath, seedId, {
		scheduledFor: null,
		lastScheduledRun: runId,
	});
}

/**
 * Merge warren-namespaced keys into a seed's `extensions` via
 * `sd update <id> --extensions <json>`. Seeds applies a shallow merge,
 * so this call only touches the keys present in `extensions` — `null`
 * clears, missing keys are left alone, and concurrent operator edits to
 * disjoint keys are safe (pl-bb70 risk #2).
 *
 * The payload is validated against `WarrenExtensionsSchema` before the
 * shell-out so bogus trigger strings or unknown keys fail fast with a
 * `SeedsCliError` rather than persisting into seeds and rotting the
 * convention. Callers that need a clear-on-not-set semantic should pass
 * `null` explicitly.
 */
export async function updateExtensions(
	deps: SeedsCliDeps,
	projectPath: string,
	seedId: string,
	extensions: WarrenExtensions,
): Promise<void> {
	const parsed = WarrenExtensionsSchema.safeParse(extensions);
	if (!parsed.success) {
		throw new SeedsCliError(
			`updateExtensions payload did not match the warren-namespaced schema: ${parsed.error.issues
				.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
				.join("; ")}`,
		);
	}
	const payload = JSON.stringify(parsed.data);
	const result = await deps.spawn([deps.sdBinary, "update", seedId, "--extensions", payload], {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new SeedsCliError(
			`sd update ${seedId} exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
		);
	}
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
