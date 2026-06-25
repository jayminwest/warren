import { readFile } from "node:fs/promises";
import { AcceptanceError, assertEqual } from "../../lib/assert.ts";
import type { WarrenHttp } from "../../lib/http.ts";
import { waitForPlotStatus } from "./poll-helpers.ts";
import type { EventRow, ParsedPlotEvent } from "./types.ts";

/**
 * Assert the dispatch-time `ready` → `active` Plot promotion
 * (promotePlotToActiveOnDispatch, warren-dfff / #487): the `<plotId>.json`
 * snapshot reaches `active` and a `status_changed → active` event authored
 * by `user:operator` lands in the on-disk events.jsonl. This is what makes
 * the auto-done guard (`status === 'active'`) reachable via dispatch as well
 * as operator action.
 */
export async function assertPlotPromotedToActiveOnDispatch(input: {
	readonly plotJsonPath: string;
	readonly plotEventsPath: string;
	readonly timeoutMs: number;
	readonly label: string;
}): Promise<void> {
	const snapshot = await waitForPlotStatus(input.plotJsonPath, "active", input.timeoutMs);
	assertEqual(
		snapshot.status,
		"active",
		`${input.label}: dispatch promoted .plot/<id>.json status ready → active (warren-dfff)`,
	);
	const promoted = parsePlotLines(await readPlotEventLines(input.plotEventsPath)).find((ev) => {
		if (ev.type !== "status_changed") return false;
		if (ev.actor !== "user:operator") return false;
		const data = ev.data as { to?: unknown; status?: unknown } | null;
		return (data?.to ?? data?.status) === "active";
	});
	if (promoted === undefined) {
		throw new AcceptanceError(
			`${input.label}: missing dispatch-time 'status_changed' → active by user:operator in on-disk events.jsonl`,
		);
	}
}

export async function fetchAllPlanRunEvents(
	http: WarrenHttp,
	planRunId: string,
): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/plan-runs/${encodeURIComponent(planRunId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

export async function fetchAllRunEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const events: EventRow[] = [];
	for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		events.push(row as EventRow);
	}
	return events;
}

export function findTextEvent(events: readonly EventRow[], needle: string): EventRow | undefined {
	return events.find(
		(e) =>
			e.kind === "text" &&
			typeof e.payload?.text === "string" &&
			(e.payload.text as string).includes(needle),
	);
}

export interface PlotEventsTail {
	lines(): ReadonlySet<string>;
	tickOnce(): Promise<void>;
	stop(): void;
}

export function startPlotEventsTail(path: string, intervalMs: number): PlotEventsTail {
	const seen = new Set<string>();
	let stopped = false;
	const tick = async (): Promise<void> => {
		if (stopped) return;
		try {
			const body = await readFile(path, "utf8");
			for (const line of body.split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				seen.add(trimmed);
			}
		} catch {
			// not yet present — keep polling
		}
	};
	const handle = setInterval(() => {
		void tick();
	}, intervalMs);
	return {
		lines: () => seen,
		tickOnce: tick,
		stop: () => {
			stopped = true;
			clearInterval(handle);
		},
	};
}

export function parsePlotLines(lines: ReadonlySet<string>): ParsedPlotEvent[] {
	const out: ParsedPlotEvent[] = [];
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const row = parsed as { type?: unknown; actor?: unknown; at?: unknown; data?: unknown };
		if (
			typeof row.type !== "string" ||
			typeof row.actor !== "string" ||
			typeof row.at !== "string"
		) {
			continue;
		}
		out.push({ type: row.type, actor: row.actor, at: row.at, data: row.data ?? null });
	}
	return out;
}

export async function readPlotEventLines(path: string): Promise<ReadonlySet<string>> {
	const seen = new Set<string>();
	try {
		const body = await readFile(path, "utf8");
		for (const line of body.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			seen.add(trimmed);
		}
	} catch {
		// File not yet present — return empty set.
	}
	return seen;
}
