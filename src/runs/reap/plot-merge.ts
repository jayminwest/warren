import { dirname, join } from "node:path";
import type { EventRow } from "../../db/schema.ts";
import type { ReapFs, ReapStep } from "./types.ts";
import { splitLines } from "./util.ts";

/* ----------------------------------------------------------------------- */
/* Plot merge (warren-7e0f / pl-2047 step 6)                                 */
/* ----------------------------------------------------------------------- */

/**
 * Event types whose agent-emitted occurrences mirror into warren's event
 * stream. Mirrors the SPEC §11 Plot ACL surface: the three event kinds
 * that capture meaningful agent-side decisions an operator wants visible
 * on the warren run page. Other event types (note, plot_created,
 * attachment_added) merge into the project's `.plot/` but are not
 * surfaced — they are either trivial or already represented by their own
 * warren-side primitives.
 */
const MIRRORED_PLOT_EVENT_TYPES = new Set(["decision_made", "question_posed", "artifact_produced"]);

interface PlotMergeResult {
	eventsAppended: number;
	plotsUpdated: number;
	mirrored: number;
}

interface ParsedPlotEvent {
	type: string;
	actor: string;
	at: string;
	data: unknown;
}

/**
 * Replay the burrow workspace's `.plot/` deltas back into the project's
 * persistent `.plot/`. Two file kinds get merged:
 *
 *   1. `plot-*.events.jsonl` — append-only event log. Deduped by full-line
 *      content; new lines from the workspace get appended in workspace
 *      order. Idempotent: a re-run against an already-merged workspace
 *      appends nothing.
 *
 *   2. `plot-*.json` — Plot state document. Last-write-wins on
 *      `updated_at` (same primitive as mulch's `recorded_at` LWW per
 *      mx-spec §11.A). Equal `updated_at` with different contents emits
 *      a `plot.conflict` event and leaves the project copy untouched —
 *      operators triage manually.
 *
 * Agent-emitted `decision_made` / `question_posed` / `artifact_produced`
 * entries appearing in the appended event tail are mirrored into
 * warren's event stream tagged with `plot_id` so the run page surfaces
 * coordination signal without a separate Plot-side polling loop.
 *
 * Best-effort like the surrounding sub-steps — any error emits a
 * `reap_failed` step=plot_merge event and is swallowed so the caller's
 * state transition still runs.
 */
export async function mergePlot(
	workspacePath: string,
	projectPath: string,
	fs: ReapFs,
	emit: (kind: string, payload: unknown) => Promise<EventRow>,
	fail: (step: ReapStep, err: unknown, path?: string) => Promise<void>,
): Promise<PlotMergeResult> {
	const burrowDir = join(workspacePath, ".plot");
	const projectDir = join(projectPath, ".plot");
	const filenames = await fs.readdir(burrowDir);

	// Group filenames by plot id so each plot's events + json get merged
	// together. The .index.db SQLite file is intentionally excluded — the
	// Plot library rebuilds it from the json+events pair, so copying it
	// across would create stale rows.
	const plotIds = new Set<string>();
	for (const name of filenames) {
		if (name.startsWith("plot-") && name.endsWith(".events.jsonl")) {
			plotIds.add(name.slice(0, -".events.jsonl".length));
		} else if (name.startsWith("plot-") && name.endsWith(".json")) {
			plotIds.add(name.slice(0, -".json".length));
		}
	}

	let eventsAppended = 0;
	let plotsUpdated = 0;
	let mirrored = 0;

	for (const plotId of [...plotIds].sort()) {
		const eventsName = `${plotId}.events.jsonl`;
		const burrowEventsPath = join(burrowDir, eventsName);
		const projectEventsPath = join(projectDir, eventsName);
		try {
			const incoming = await fs.readFile(burrowEventsPath);
			if (incoming !== null) {
				const existing = (await fs.readFile(projectEventsPath)) ?? "";
				const result = mergePlotEventsFile(existing, incoming);
				if (result.changed) {
					await fs.mkdirp(dirname(projectEventsPath));
					await fs.writeFile(projectEventsPath, result.merged);
				}
				eventsAppended += result.appended;
				for (const ev of result.newEvents) {
					if (!MIRRORED_PLOT_EVENT_TYPES.has(ev.type)) continue;
					if (!ev.actor.startsWith("agent:")) continue;
					await emit(`plot.${ev.type}`, {
						plotId,
						actor: ev.actor,
						at: ev.at,
						data: ev.data,
					});
					mirrored += 1;
				}
			}
		} catch (err) {
			await fail("plot_merge", err, burrowEventsPath);
		}

		const jsonName = `${plotId}.json`;
		const burrowJsonPath = join(burrowDir, jsonName);
		const projectJsonPath = join(projectDir, jsonName);
		try {
			const incoming = await fs.readFile(burrowJsonPath);
			if (incoming !== null) {
				const existing = await fs.readFile(projectJsonPath);
				const result = mergePlotJsonFile(existing, incoming);
				if (result.changed) {
					await fs.mkdirp(dirname(projectJsonPath));
					await fs.writeFile(projectJsonPath, result.merged);
					plotsUpdated += 1;
					await emit("plot.updated", { plotId });
				}
				if (result.conflict !== null) {
					await emit("plot.conflict", { plotId, reason: result.conflict });
				}
			}
		} catch (err) {
			await fail("plot_merge", err, burrowJsonPath);
		}
	}

	return { eventsAppended, plotsUpdated, mirrored };
}

interface PlotEventsMergeResult {
	merged: string;
	changed: boolean;
	appended: number;
	newEvents: ParsedPlotEvent[];
}

/**
 * Pure: merge a single Plot's events.jsonl. Existing project lines keep
 * their position and order; workspace lines not already present land at
 * the tail in workspace order. Append-only events have no LWW shape —
 * dedup by exact line content is the natural primitive.
 *
 * Exported for unit testing in isolation from the disk + event surface.
 */
export function mergePlotEventsFile(
	existingBody: string,
	incomingBody: string,
): PlotEventsMergeResult {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const line of splitLines(existingBody)) {
		if (seen.has(line)) continue;
		seen.add(line);
		lines.push(line);
	}
	let appended = 0;
	const newEvents: ParsedPlotEvent[] = [];
	for (const line of splitLines(incomingBody)) {
		if (seen.has(line)) continue;
		seen.add(line);
		lines.push(line);
		appended += 1;
		const parsed = parsePlotEvent(line);
		if (parsed !== null) newEvents.push(parsed);
	}
	const merged = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
	const changed = appended > 0 || (merged !== existingBody && existingBody !== "");
	return { merged, changed, appended, newEvents };
}

function parsePlotEvent(line: string): ParsedPlotEvent | null {
	try {
		const raw: unknown = JSON.parse(line);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const obj = raw as Record<string, unknown>;
		const type = typeof obj.type === "string" ? obj.type : null;
		const actor = typeof obj.actor === "string" ? obj.actor : null;
		const at = typeof obj.at === "string" ? obj.at : null;
		if (type === null || actor === null || at === null) return null;
		return { type, actor, at, data: obj.data };
	} catch {
		return null;
	}
}

interface PlotJsonMergeResult {
	merged: string;
	changed: boolean;
	conflict: string | null;
}

/**
 * Pure: merge a single Plot's plot-id.json. LWW on `updated_at`. Equal
 * `updated_at` with content drift is a real conflict (two writers
 * touched the same revision) — surface it as `plot.conflict` and keep
 * the existing project copy so an operator can triage.
 *
 * Exported for unit testing.
 */
export function mergePlotJsonFile(existing: string | null, incoming: string): PlotJsonMergeResult {
	if (existing === null) return { merged: incoming, changed: true, conflict: null };
	if (existing === incoming) return { merged: existing, changed: false, conflict: null };
	const existingTs = readUpdatedAt(existing);
	const incomingTs = readUpdatedAt(incoming);
	if (incomingTs > existingTs) {
		return { merged: incoming, changed: true, conflict: null };
	}
	if (incomingTs < existingTs) {
		return { merged: existing, changed: false, conflict: null };
	}
	return {
		merged: existing,
		changed: false,
		conflict: "updated_at matches but contents differ",
	};
}

function readUpdatedAt(body: string): string {
	try {
		const raw: unknown = JSON.parse(body);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "";
		const ts = (raw as Record<string, unknown>).updated_at;
		return typeof ts === "string" ? ts : "";
	} catch {
		return "";
	}
}
