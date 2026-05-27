import { dirname, join } from "node:path";
import type { EventRow } from "../../db/schema.ts";
import type { ReapFs, ReapStep } from "./types.ts";
import { splitLines } from "./util.ts";

/* ----------------------------------------------------------------------- */
/* Mulch merge (SPEC §11.A)                                                 */
/* ----------------------------------------------------------------------- */

export interface MulchMergeResult {
	updated: number;
	skipped: number;
	appended: number;
}

interface MulchEntry {
	raw: string;
	id: string | null;
	recordedAt: string;
}

export async function mergeMulch(
	workspacePath: string,
	projectPath: string,
	fs: ReapFs,
	emit: (kind: string, payload: unknown) => Promise<EventRow>,
	fail: (step: ReapStep, err: unknown, path?: string) => Promise<void>,
): Promise<MulchMergeResult> {
	const burrowDir = join(workspacePath, ".mulch", "expertise");
	const projectDir = join(projectPath, ".mulch", "expertise");
	const filenames = (await fs.readdir(burrowDir)).filter((n) => n.endsWith(".jsonl")).sort();

	let updated = 0;
	let skipped = 0;
	let appended = 0;

	for (const filename of filenames) {
		const domain = filename.slice(0, -".jsonl".length);
		const burrowPath = join(burrowDir, filename);
		const projectPath2 = join(projectDir, filename);
		try {
			const incoming = await fs.readFile(burrowPath);
			if (incoming === null) continue;
			const existing = (await fs.readFile(projectPath2)) ?? "";
			const result = await mergeMulchFile(domain, existing, incoming, emit);
			if (result.changed) {
				await fs.mkdirp(dirname(projectPath2));
				await fs.writeFile(projectPath2, result.merged);
			}
			updated += result.updated;
			skipped += result.skipped;
			appended += result.appended;
		} catch (err) {
			await fail("mulch_merge", err, burrowPath);
		}
	}

	return { updated, skipped, appended };
}

interface MulchFileMergeResult {
	merged: string;
	changed: boolean;
	updated: number;
	skipped: number;
	appended: number;
}

/**
 * Pure: merge a single domain's JSONL. Existing entries keep their
 * original order; new (or replaced) entries land at the end of the
 * file in incoming order. Anonymous records (no `id`) always append —
 * spec §11.A says they have no conflict possible.
 *
 * Exported for unit-testing in isolation from the disk + event surface.
 */
export async function mergeMulchFile(
	domain: string,
	existingBody: string,
	incomingBody: string,
	emit: (kind: string, payload: unknown) => Promise<EventRow>,
): Promise<MulchFileMergeResult> {
	const entries: MulchEntry[] = [];
	const idIndex = new Map<string, number>();

	for (const line of splitLines(existingBody)) {
		let parsed: Record<string, unknown> | null = null;
		try {
			const raw: unknown = JSON.parse(line);
			if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
				parsed = raw as Record<string, unknown>;
			}
		} catch {
			// keep an unparseable line as-is so we never lose data the user wrote.
		}
		const id = parsed !== null && typeof parsed.id === "string" ? parsed.id : null;
		const recordedAt =
			parsed !== null && typeof parsed.recorded_at === "string" ? parsed.recorded_at : "";
		const idx = entries.length;
		entries.push({ raw: line, id, recordedAt });
		if (id !== null) idIndex.set(id, idx);
	}

	let updated = 0;
	let skipped = 0;
	let appended = 0;

	for (const line of splitLines(incomingBody)) {
		let parsed: Record<string, unknown>;
		try {
			const raw: unknown = JSON.parse(line);
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
				await emit("reap_failed", {
					step: "mulch_merge",
					message: `expertise/${domain}.jsonl: line is not a JSON object`,
				});
				continue;
			}
			parsed = raw as Record<string, unknown>;
		} catch (err) {
			await emit("reap_failed", {
				step: "mulch_merge",
				message: `expertise/${domain}.jsonl: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
			});
			continue;
		}
		const id = typeof parsed.id === "string" ? parsed.id : null;
		const recordedAt = typeof parsed.recorded_at === "string" ? parsed.recorded_at : "";

		if (id !== null) {
			const existingIdx = idIndex.get(id);
			if (existingIdx !== undefined) {
				const existing = entries[existingIdx];
				if (existing === undefined) continue;
				if (recordedAt > existing.recordedAt) {
					entries[existingIdx] = { raw: line, id, recordedAt };
					updated += 1;
					await emit("mulch.record.updated", {
						domain,
						id,
						previousRecordedAt: existing.recordedAt || null,
						newRecordedAt: recordedAt || null,
					});
				} else {
					skipped += 1;
					await emit("mulch.record.skipped", {
						domain,
						id,
						incomingRecordedAt: recordedAt || null,
						existingRecordedAt: existing.recordedAt || null,
					});
				}
				continue;
			}
		}

		const idx = entries.length;
		entries.push({ raw: line, id, recordedAt });
		if (id !== null) idIndex.set(id, idx);
		appended += 1;
		await emit("mulch.record.added", { domain, id });
	}

	const merged = entries.length === 0 ? "" : `${entries.map((e) => e.raw).join("\n")}\n`;
	const changed = updated > 0 || appended > 0 || (merged !== existingBody && existingBody !== "");
	return { merged, changed, updated, skipped, appended };
}
