/**
 * Eviction strategy: per-tick decision-and-action loop (warren-d0a9
 * split of src/preview/eviction.ts). Walks every preview in
 * `starting`/`live`, applies the four-signal contract (idle-TTL,
 * max-lifetime, LRU; manual teardown handled elsewhere), and emits a
 * `preview_evicted` event per row that gets reaped.
 *
 * Every observable side effect (clock, sidecar client, db, events) is
 * injectable so unit tests don't touch real sockets or wait on real
 * timers. The CAS in `previews.evict` is a single conditional UPDATE,
 * so a racing manual teardown is naturally idempotent at the SQL
 * layer.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { RunEventBroker } from "../../runs/events.ts";
import type { WarrenConfigCache } from "../../warren-config/index.ts";
import { parseDurationMs } from "../duration.ts";
import { createRunPreviewsRepo } from "./repo.ts";
import { createPoolSidecarResolver } from "./sidecar.ts";
import type {
	EvictionReason,
	PreviewEvictionLogger,
	PreviewEvictionTickInput,
	PreviewEvictionTickResult,
	RunPreviewRow,
	RunPreviewsRepo,
	SidecarClient,
	SidecarResolver,
} from "./types.ts";

export async function runPreviewEvictionTick(
	input: PreviewEvictionTickInput,
): Promise<PreviewEvictionTickResult> {
	const now = input.now?.() ?? new Date();
	const previews = input.previews ?? createRunPreviewsRepo(input.db);
	const resolveSidecar = input.resolveSidecar ?? createPoolSidecarResolver(input.burrowClientPool);

	const rows = await previews.listActivePreviews();
	const evicted: { runId: string; reason: EvictionReason }[] = [];
	const skipped: { runId: string; reason: string }[] = [];
	const survivors: SurvivorRow[] = [];

	for (const row of rows) {
		const decision = await classifyRow({
			row,
			now,
			warrenConfigs: input.warrenConfigs,
			globalIdleTtlMs: input.config.idleTtlMs,
			globalMaxLifetimeMs: input.config.maxLifetimeMs,
			projectsRepo: input.repos.projects,
			logger: input.logger,
		});
		if (decision.kind === "evict") {
			await applyEviction({
				row,
				reason: decision.reason,
				now,
				resolveSidecar,
				previews,
				repos: input.repos,
				broker: input.broker,
				logger: input.logger,
				evicted,
				skipped,
			});
		} else {
			survivors.push({ row, idleSince: decision.idleSince });
		}
	}

	if (survivors.length > input.config.maxLive) {
		survivors.sort(compareIdleSinceAsc);
		const overflow = survivors.length - input.config.maxLive;
		for (let i = 0; i < overflow; i += 1) {
			const survivor = survivors[i];
			if (survivor === undefined) continue;
			await applyEviction({
				row: survivor.row,
				reason: "lru",
				now,
				resolveSidecar,
				previews,
				repos: input.repos,
				broker: input.broker,
				logger: input.logger,
				evicted,
				skipped,
			});
		}
	}

	return { scanned: rows.length, evicted, skipped };
}

interface SurvivorRow {
	readonly row: RunPreviewRow;
	/** Effective idle clock (last hit, falling back to started_at). */
	readonly idleSince: number;
}

function compareIdleSinceAsc(a: SurvivorRow, b: SurvivorRow): number {
	return a.idleSince - b.idleSince;
}

type RowDecision = { kind: "keep"; idleSince: number } | { kind: "evict"; reason: EvictionReason };

interface ClassifyInput {
	readonly row: RunPreviewRow;
	readonly now: Date;
	readonly warrenConfigs: WarrenConfigCache;
	readonly globalIdleTtlMs: number;
	readonly globalMaxLifetimeMs: number;
	readonly projectsRepo: Repos["projects"];
	readonly logger?: PreviewEvictionLogger;
}

async function classifyRow(input: ClassifyInput): Promise<RowDecision> {
	const nowMs = input.now.getTime();
	const startedMs = input.row.previewStartedAt
		? Date.parse(input.row.previewStartedAt)
		: Number.NaN;
	const lastHitMs = input.row.previewLastHitAt
		? Date.parse(input.row.previewLastHitAt)
		: Number.NaN;

	// Idle clock falls back to started_at when the row hasn't been hit yet;
	// otherwise a `live` preview that no one ever visits stays alive
	// forever despite the operator opting into idle eviction.
	const idleSinceMs = Number.isFinite(lastHitMs)
		? lastHitMs
		: Number.isFinite(startedMs)
			? startedMs
			: nowMs;

	const projectOverrides = await loadProjectOverrides(input);

	const maxLifetimeMs = projectOverrides.maxLifetimeMs ?? input.globalMaxLifetimeMs;
	if (Number.isFinite(startedMs) && nowMs - startedMs > maxLifetimeMs) {
		return { kind: "evict", reason: "max_lifetime" };
	}

	const idleTtlMs = projectOverrides.idleTtlMs ?? input.globalIdleTtlMs;
	if (nowMs - idleSinceMs > idleTtlMs) {
		return { kind: "evict", reason: "idle_ttl" };
	}

	return { kind: "keep", idleSince: idleSinceMs };
}

async function loadProjectOverrides(
	input: ClassifyInput,
): Promise<{ idleTtlMs?: number; maxLifetimeMs?: number }> {
	if (input.row.projectId === null) return {};
	const project = await input.projectsRepo.get(input.row.projectId);
	if (project === null) return {};
	const loaded = await tryLoadWarrenConfig(input, project.id, project.localPath);
	if (loaded === null) return {};
	const preview = loaded.defaults?.preview;
	if (preview === undefined || preview.type !== "server") return {};
	const out: { idleTtlMs?: number; maxLifetimeMs?: number } = {};
	const idleTtl = parseOverrideDuration(
		input,
		project.id,
		preview.idle_ttl,
		"preview_eviction.idle_ttl_parse_failed",
	);
	if (idleTtl !== undefined) out.idleTtlMs = idleTtl;
	const maxLifetime = parseOverrideDuration(
		input,
		project.id,
		preview.max_lifetime,
		"preview_eviction.max_lifetime_parse_failed",
	);
	if (maxLifetime !== undefined) out.maxLifetimeMs = maxLifetime;
	return out;
}

async function tryLoadWarrenConfig(
	input: ClassifyInput,
	projectId: string,
	localPath: string,
): Promise<Awaited<ReturnType<WarrenConfigCache["get"]>> | null> {
	try {
		return await input.warrenConfigs.get(projectId, localPath);
	} catch (err) {
		input.logger?.warn(
			{
				runId: input.row.runId,
				projectId,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview_eviction.warren_config_load_failed",
		);
		return null;
	}
}

function parseOverrideDuration(
	input: ClassifyInput,
	projectId: string,
	raw: string | undefined,
	logMsg: string,
): number | undefined {
	if (raw === undefined) return undefined;
	try {
		return parseDurationMs(raw);
	} catch (err) {
		input.logger?.warn(
			{
				runId: input.row.runId,
				projectId,
				value: raw,
				err: err instanceof Error ? err.message : String(err),
			},
			logMsg,
		);
		return undefined;
	}
}

interface ApplyEvictionInput {
	readonly row: RunPreviewRow;
	readonly reason: EvictionReason;
	readonly now: Date;
	readonly resolveSidecar: SidecarResolver;
	readonly previews: RunPreviewsRepo;
	readonly repos: Repos;
	readonly broker?: RunEventBroker;
	readonly logger?: PreviewEvictionLogger;
	readonly evicted: Array<{ runId: string; reason: EvictionReason }>;
	readonly skipped: Array<{ runId: string; reason: string }>;
}

async function applyEviction(input: ApplyEvictionInput): Promise<void> {
	const claimed = await input.previews.evict({
		runId: input.row.runId,
		reason: input.reason,
		now: input.now,
	});
	if (!claimed) {
		// Lost the race against another writer (manual teardown, retry).
		input.skipped.push({ runId: input.row.runId, reason: "state_changed" });
		return;
	}

	if (input.row.burrowId !== null) {
		await stopSidecarsForRow(input);
	}

	await emitEvictedEvent(input);

	input.evicted.push({ runId: input.row.runId, reason: input.reason });
	input.logger?.info(
		{
			runId: input.row.runId,
			reason: input.reason,
			port: input.row.previewPort,
			previousState: input.row.previewState,
		},
		"preview_evicted",
	);
}

async function stopSidecarsForRow(input: ApplyEvictionInput): Promise<void> {
	const burrowId = input.row.burrowId;
	if (burrowId === null) return;
	try {
		const sidecars = await input.resolveSidecar(burrowId);
		if (sidecars === null) {
			input.logger?.warn(
				{ runId: input.row.runId, burrowId },
				"preview_eviction.sidecar_resolver_returned_null",
			);
			return;
		}
		const list = await sidecars.list(burrowId);
		for (const sc of list) {
			await deleteSidecarSafely(input, sidecars, burrowId, sc.id);
		}
	} catch (err) {
		input.logger?.warn(
			{
				runId: input.row.runId,
				burrowId,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview_eviction.sidecar_stop_failed",
		);
	}
}

async function deleteSidecarSafely(
	input: ApplyEvictionInput,
	sidecars: SidecarClient,
	burrowId: string,
	sidecarId: string,
): Promise<void> {
	try {
		await sidecars.delete(burrowId, sidecarId);
	} catch (err) {
		input.logger?.warn(
			{
				runId: input.row.runId,
				burrowId,
				sidecarId,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview_eviction.sidecar_delete_failed",
		);
	}
}

async function emitEvictedEvent(input: ApplyEvictionInput): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.row.runId)) ?? 0) + 1;
		const event = await input.repos.events.append({
			runId: input.row.runId,
			burrowEventSeq: seq,
			ts: input.now.toISOString(),
			kind: "preview_evicted",
			stream: "system",
			payload: {
				reason: input.reason,
				port: input.row.previewPort,
				previousState: input.row.previewState,
			},
		});
		input.broker?.publish(input.row.runId, event);
	} catch (err) {
		input.logger?.error(
			{
				runId: input.row.runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"preview_eviction.event_emit_failed",
		);
	}
}
