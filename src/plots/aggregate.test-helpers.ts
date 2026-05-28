import { expect } from "bun:test";
import type { PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import type { ProjectRow, RunRow } from "../db/schema.ts";
import type { Logger } from "../server/types.ts";
import type {
	AggregatorClientFactory,
	AggregatorPlotClient,
	AggregatorRunsRepo,
} from "./aggregate.ts";

export function silentLogger(): Logger {
	return {
		info() {},
		warn() {},
		error() {},
	};
}

export function captureLogger(): { logger: Logger; warns: Array<{ obj: object; msg?: string }> } {
	const warns: Array<{ obj: object; msg?: string }> = [];
	return {
		warns,
		logger: {
			info() {},
			warn(obj, msg) {
				warns.push({ obj, msg });
			},
			error() {},
		},
	};
}

export function project(id: string, hasPlot = true): ProjectRow {
	return {
		id,
		gitUrl: `https://example.com/${id}.git`,
		localPath: `/tmp/${id}`,
		defaultBranch: "main",
		addedAt: "2026-01-01T00:00:00Z",
		lastFetchedAt: null,
		lastHeadSha: null,
		hasPlot,
		hasSeeds: false,
	};
}

export interface StubPlot {
	readonly id: string;
	readonly name: string;
	readonly status: PlotStatus;
	readonly updated_at: string;
	readonly goal: string;
	readonly attachments: number;
	readonly events: ReadonlyArray<PlotEvent>;
}

export interface StubBehaviour {
	readonly plots: ReadonlyArray<StubPlot>;
	readonly failFirstQuery?: boolean;
	readonly failAllQueries?: boolean;
	/**
	 * Plots that exist on disk as `*.json` files but are missing from
	 * the index DB. When set, `query()` returns rows derived from
	 * `plots` (typically empty until `rebuildIndex` runs), and
	 * `rebuildIndex` migrates these into `plots` so the retry sees
	 * them. Models the warren-ede7 cold-cache empty-rows path.
	 */
	readonly plotsOnDiskOnly?: ReadonlyArray<StubPlot>;
	/**
	 * Override the disk probe result. When `plotsOnDiskOnly` is set
	 * this defaults to `true`; otherwise to `plots.length > 0`.
	 */
	readonly hasFilesOnDisk?: boolean;
}

export interface StubMetrics {
	queryCalls: number;
	rebuildCalls: number;
	closeCalls: number;
	hasFilesOnDiskCalls: number;
	countFilesOnDiskCalls: number;
}

export function makeFactory(perProject: Record<string, StubBehaviour>): {
	factory: AggregatorClientFactory;
	metrics: Record<string, StubMetrics>;
} {
	const metrics: Record<string, StubMetrics> = {};
	const factory: AggregatorClientFactory = (p) => {
		const behaviour = perProject[p.id];
		if (behaviour === undefined) {
			throw new Error(`unexpected project in factory: ${p.id}`);
		}
		let m = metrics[p.id];
		if (m === undefined) {
			m = {
				queryCalls: 0,
				rebuildCalls: 0,
				closeCalls: 0,
				hasFilesOnDiskCalls: 0,
				countFilesOnDiskCalls: 0,
			};
			metrics[p.id] = m;
		}
		// Live view of indexed plots — rebuildIndex absorbs the
		// `plotsOnDiskOnly` set so the retry query sees them.
		const indexed: StubPlot[] = [...behaviour.plots];
		const onDiskOnly: StubPlot[] = behaviour.plotsOnDiskOnly ? [...behaviour.plotsOnDiskOnly] : [];
		const client: AggregatorPlotClient = {
			async query() {
				m.queryCalls += 1;
				if (behaviour.failAllQueries) throw new Error("query-broken");
				if (behaviour.failFirstQuery && m.queryCalls === 1) {
					throw new Error("first-query-broken");
				}
				return { rows: indexed.map((pl) => ({ id: pl.id })) };
			},
			async rebuildIndex() {
				m.rebuildCalls += 1;
				while (onDiskOnly.length > 0) {
					const next = onDiskOnly.shift();
					if (next !== undefined) indexed.push(next);
				}
			},
			async hasPlotFilesOnDisk() {
				m.hasFilesOnDiskCalls += 1;
				if (behaviour.hasFilesOnDisk !== undefined) return behaviour.hasFilesOnDisk;
				if (onDiskOnly.length > 0 || indexed.length > 0) return true;
				return false;
			},
			async countPlotFilesOnDisk() {
				m.countFilesOnDiskCalls += 1;
				return indexed.length + onDiskOnly.length;
			},
			async readPlot(plotId) {
				const pl = indexed.find((x) => x.id === plotId);
				if (pl === undefined) throw new Error(`unknown plot ${plotId}`);
				return {
					name: pl.name,
					status: pl.status,
					updated_at: pl.updated_at,
					intent: { goal: pl.goal },
					attachments: new Array(pl.attachments).fill(null),
				};
			},
			async readEvents(plotId) {
				const pl = indexed.find((x) => x.id === plotId);
				if (pl === undefined) throw new Error(`unknown plot ${plotId}`);
				return pl.events;
			},
			close() {
				m.closeCalls += 1;
			},
		};
		return client;
	};
	return { factory, metrics };
}

export function noteEvent(at: string, actor: string): PlotEvent {
	return {
		type: "note",
		actor,
		at,
		data: { text: "x" },
	};
}

export function pausedRunsRepo(plotIds: readonly (string | null)[]): AggregatorRunsRepo {
	return {
		async listByState(state) {
			expect(state).toBe("paused");
			return plotIds.map((id) => ({ plotId: id }) as unknown as RunRow);
		},
	};
}
