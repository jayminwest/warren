#!/usr/bin/env bun
/**
 * Git merge driver for id-keyed JSONL state files (warren-9c90).
 *
 * Registered in .gitattributes as `merge=seeds-jsonl` for the seeds and
 * mulch state files whose writers REWRITE rows in place, where
 * `merge=union` silently emitted two contradictory copies of a rewritten
 * row. Git invokes the driver as:
 *
 *   merge.seeds-jsonl.driver = bun scripts/merge-seeds-jsonl.ts %O %A %B
 *
 * %O = common ancestor, %A = ours (result is written over this file),
 * %B = theirs. Exit 0 = resolved; non-zero = genuine conflict. On a
 * genuine conflict the driver still writes a best-effort merge over %A:
 * every resolvable row is 3-way merged, and only the unresolvable rows
 * carry standard git conflict markers (<<<<<<< ours / ======= /
 * >>>>>>> theirs). Leaving pure ours-content in %A silently resurrected
 * the other side's closes when a repair flow committed the working file
 * (warren-585f, observed live on PR #859). The marker lines are invalid
 * JSONL on purpose — `check:seeds-integrity` refuses them, so the file
 * cannot be committed without a human decision.
 *
 * Merge rules (all comparisons are against the ancestor, per row keyed
 * by `id`):
 *   - present on only one side: take it
 *   - changed on one side only: take the changed side
 *   - changed on both sides: per-field merge; a field changed by only
 *     one side takes that side, changed by both to the same value takes
 *     it, changed by both to different values is a conflict — except
 *     array fields, where each side's additions and removals relative
 *     to the ancestor are both applied, and pure-timestamp fields
 *     (updatedAt always; closedAt when both sides agree the row is
 *     closed), which auto-resolve to the later timestamp (warren-5f0d)
 *   - deleted on one side and unchanged on the other: deleted wins
 *   - deleted on one side and changed on the other: conflict
 *
 * Row order is deterministic (ours' order, then theirs-only rows in
 * theirs' order), and rows taken verbatim keep their original line
 * text, so a one-sided change merges byte-identically to that side.
 *
 * Limitation: git only runs merge drivers locally. GitHub's server-side
 * merges (gh pr update-branch, squash-merge) never run this driver; the
 * `check:seeds-integrity` lint gate remains the backstop for that path.
 */

type Row = { obj: Record<string, unknown>; line: string };

type Stage = {
	rows: Map<string, Row>;
	order: string[];
};

const same = (a: unknown, b: unknown): boolean =>
	a === undefined ? b === undefined : b !== undefined && JSON.stringify(a) === JSON.stringify(b);

function parseStage(content: string, label: string): Stage {
	const rows = new Map<string, Row>();
	const order: string[] = [];
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line) as Record<string, unknown>;
		} catch {
			throw new Error(`${label}: unparseable line, refusing to merge: ${line.slice(0, 80)}`);
		}
		const id = obj.id;
		if (typeof id !== "string" || id === "") {
			throw new Error(`${label}: row without a string "id", refusing to merge`);
		}
		if (!rows.has(id)) order.push(id);
		rows.set(id, { obj, line });
	}
	return { rows, order };
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

/**
 * Set-merge an array field: apply both sides' removals and additions
 * relative to the ancestor. Retained ancestor items keep ancestor
 * order, additions follow in ours-then-theirs order.
 */
function mergeArrayField(anc: unknown, ours: unknown, theirs: unknown): unknown {
	const a = asStringArray(anc) ?? [];
	const o = asStringArray(ours) ?? [];
	const t = asStringArray(theirs) ?? [];
	const removed = new Set(a.filter((x) => !o.includes(x) || !t.includes(x)));
	const result = a.filter((x) => !removed.has(x));
	for (const x of [...o, ...t]) {
		if (!removed.has(x) && !result.includes(x)) result.push(x);
	}
	return result;
}

/**
 * Merge a row changed on both sides, field by field. Returns the merged
 * object, or undefined on a genuine unresolvable field conflict.
 */
function mergeRow(
	id: string,
	anc: Record<string, unknown>,
	ours: Record<string, unknown>,
	theirs: Record<string, unknown>,
	conflicts: string[],
): Record<string, unknown> | undefined {
	const merged: Record<string, unknown> = {};
	const localConflicts: string[] = [];
	const bothClosed = ours.status === "closed" && theirs.status === "closed";
	const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
	for (const key of keys) {
		const resolved = mergeField(key, anc[key], ours[key], theirs[key], bothClosed);
		if (resolved.conflict) localConflicts.push(`${id}.${key}`);
		else if (resolved.value !== undefined) merged[key] = resolved.value;
	}
	if (localConflicts.length > 0) {
		conflicts.push(...localConflicts);
		return undefined;
	}
	return merged;
}

/** Parse an ISO timestamp string to millis, or undefined when not a timestamp. */
function asTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Resolve one field of a both-sides-changed row against the ancestor.
 * `bothClosed` is true when ours and theirs both carry status "closed",
 * which makes closedAt a pure timestamp rather than contested content.
 */
function mergeField(
	key: string,
	a: unknown,
	o: unknown,
	t: unknown,
	bothClosed: boolean,
): { value?: unknown; conflict?: boolean } {
	const oursChanged = !same(o, a);
	const theirsChanged = !same(t, a);
	if (!oursChanged) return { value: t };
	if (!theirsChanged || same(o, t)) return { value: o };
	const isArray =
		asStringArray(a) !== undefined ||
		asStringArray(o) !== undefined ||
		asStringArray(t) !== undefined;
	if (isArray) return { value: mergeArrayField(a, o, t) };
	// Pure-timestamp fields auto-resolve to the later value (warren-5f0d):
	// updatedAt is bookkeeping, and closedAt is bookkeeping once both
	// sides agree the row is closed. Non-timestamp values still conflict.
	if (key === "updatedAt" || (key === "closedAt" && bothClosed)) {
		const oMs = asTimestamp(o);
		const tMs = asTimestamp(t);
		if (oMs !== undefined && tMs !== undefined) return { value: oMs >= tMs ? o : t };
	}
	return { conflict: true };
}

type RowResolution =
	| { kind: "take"; line: string }
	| { kind: "drop" }
	| { kind: "conflict"; oursLine?: string; theirsLine?: string };

/**
 * Resolve a row present on only one side: added there (take it), or
 * deleted by the other side (deletion wins unless this side edited it,
 * which is a genuine edit/delete conflict).
 */
function resolveOneSided(present: Row, a: Row | undefined, side: "ours" | "theirs"): RowResolution {
	if (!a) return { kind: "take", line: present.line };
	if (!same(present.obj, a.obj)) {
		return side === "ours"
			? { kind: "conflict", oursLine: present.line }
			: { kind: "conflict", theirsLine: present.line };
	}
	return { kind: "drop" };
}

/** Resolve one id across the three stages into an output line, a drop, or a conflict. */
function resolveRow(
	id: string,
	a: Row | undefined,
	o: Row | undefined,
	t: Row | undefined,
	conflicts: string[],
): RowResolution {
	if (o && !t) return resolveOneSided(o, a, "ours");
	if (t && !o) return resolveOneSided(t, a, "theirs");
	if (!o || !t) return { kind: "drop" }; // deleted by both
	const ancObj = a?.obj ?? {}; // absent ancestor: both sides added this id
	const oursChanged = a === undefined || !same(o.obj, ancObj);
	const theirsChanged = a === undefined || !same(t.obj, ancObj);
	if (!oursChanged) return { kind: "take", line: t.line };
	if (!theirsChanged || same(o.obj, t.obj)) return { kind: "take", line: o.line };
	const merged = mergeRow(id, ancObj, o.obj, t.obj, conflicts);
	return merged
		? { kind: "take", line: JSON.stringify(merged) }
		: { kind: "conflict", oursLine: o.line, theirsLine: t.line };
}

/** Standard git conflict-marker block around the two versions of a row. */
function conflictBlock(oursLine: string | undefined, theirsLine: string | undefined): string {
	return [
		"<<<<<<< ours",
		...(oursLine !== undefined ? [oursLine] : []),
		"=======",
		...(theirsLine !== undefined ? [theirsLine] : []),
		">>>>>>> theirs",
	].join("\n");
}

/**
 * Three-way merge of id-keyed JSONL. Always returns the merged file
 * content plus the list of genuine conflicts. Resolvable rows are 3-way
 * merged; unresolvable rows are emitted as git conflict-marker blocks so
 * the result cannot be committed silently (warren-585f).
 */
export function mergeJsonl(
	ancestorContent: string,
	oursContent: string,
	theirsContent: string,
): { content: string; conflicts: string[] } {
	const anc = parseStage(ancestorContent, "ancestor");
	const ours = parseStage(oursContent, "ours");
	const theirs = parseStage(theirsContent, "theirs");

	const out: string[] = [];
	const conflicts: string[] = [];
	const conflictIds: string[] = [];

	const ordered = [...ours.order, ...theirs.order.filter((id) => !ours.rows.has(id))];
	for (const id of ordered) {
		const resolution = resolveRow(
			id,
			anc.rows.get(id),
			ours.rows.get(id),
			theirs.rows.get(id),
			conflicts,
		);
		if (resolution.kind === "take") out.push(resolution.line);
		else if (resolution.kind === "conflict") {
			conflictIds.push(id);
			out.push(conflictBlock(resolution.oursLine, resolution.theirsLine));
		}
	}
	for (const id of conflictIds) {
		if (!conflicts.some((c) => c.startsWith(`${id}.`))) conflicts.push(`${id} (edit/delete race)`);
	}

	if (conflicts.length > 0) {
		console.error(`merge-seeds-jsonl: unresolvable conflicts:\n  ${conflicts.join("\n  ")}`);
	}
	return { content: `${out.join("\n")}\n`, conflicts };
}

async function main(): Promise<number> {
	const [ancestorPath, oursPath, theirsPath] = process.argv.slice(2);
	if (!ancestorPath || !oursPath || !theirsPath) {
		console.error("usage: merge-seeds-jsonl.ts <ancestor %O> <ours %A> <theirs %B>");
		return 2;
	}
	const [ancestor, oursFile, theirs] = await Promise.all([
		Bun.file(ancestorPath).text(),
		Bun.file(oursPath).text(),
		Bun.file(theirsPath).text(),
	]);
	let merged: { content: string; conflicts: string[] };
	try {
		merged = mergeJsonl(ancestor, oursFile, theirs);
	} catch (err) {
		console.error(`merge-seeds-jsonl: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	// Best-effort result is always written over %A, even on conflict, so
	// the working file shows both sides instead of silently keeping ours.
	await Bun.write(oursPath, merged.content);
	return merged.conflicts.length > 0 ? 1 : 0;
}

if (import.meta.main) {
	process.exit(await main());
}
