import { dirname, join } from "node:path";
import { NotFoundError } from "@os-eco/burrow-cli";
import type { BurrowClient } from "../../burrow-client/client.ts";
import { withTransportMapping } from "../../burrow-client/client.ts";
import type { EventRow } from "../../db/schema.ts";
import type { ReapFs } from "./types.ts";
import { splitLines } from "./util.ts";

/* ----------------------------------------------------------------------- */
/* Seeds close mirror                                                       */
/* ----------------------------------------------------------------------- */

interface SeedRow {
	id: string;
	status: string;
	updatedAt: string;
	raw: string;
}

interface MirrorClosedSeedsInput {
	readonly burrowClient: BurrowClient;
	readonly burrowId: string;
	readonly projectPath: string;
	readonly fs: ReapFs;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

interface MirrorSeedsResult {
	readonly closed: number;
	readonly created: number;
}

export async function mirrorSeeds(input: MirrorClosedSeedsInput): Promise<MirrorSeedsResult> {
	const { burrowClient, burrowId, projectPath, fs, emit } = input;
	const projectFile = join(projectPath, ".seeds", "issues.jsonl");

	let burrowBody: string;
	try {
		const out = await withTransportMapping(burrowClient.config, () =>
			burrowClient.http.files.read(burrowId, ".seeds/issues.jsonl"),
		);
		burrowBody = out.contents;
	} catch (err) {
		if (err instanceof NotFoundError) return { closed: 0, created: 0 };
		throw err;
	}

	const projectBody = (await fs.readFile(projectFile)) ?? "";
	const projectRows = parseSeeds(projectBody);
	const projectIndex = new Map<string, number>();
	for (let i = 0; i < projectRows.length; i++) {
		const row = projectRows[i];
		if (row !== undefined) projectIndex.set(row.id, i);
	}

	let closed = 0;
	let created = 0;
	let changed = false;

	for (const incoming of parseSeeds(burrowBody)) {
		const existingIdx = projectIndex.get(incoming.id);
		if (existingIdx === undefined) {
			projectRows.push(incoming);
			projectIndex.set(incoming.id, projectRows.length - 1);
			changed = true;
			if (incoming.status === "closed") {
				closed += 1;
				await emit("seeds.closed", { id: incoming.id, mode: "added" });
			} else {
				created += 1;
				await emit("seeds.created", { id: incoming.id, status: incoming.status });
			}
			continue;
		}
		if (incoming.status !== "closed") continue;
		const existing = projectRows[existingIdx];
		if (existing === undefined) continue;
		if (existing.status === "closed" && existing.updatedAt >= incoming.updatedAt) continue;
		if (incoming.updatedAt <= existing.updatedAt) continue;
		projectRows[existingIdx] = incoming;
		closed += 1;
		changed = true;
		await emit("seeds.closed", { id: incoming.id, mode: "updated" });
	}

	if (changed) {
		await fs.mkdirp(dirname(projectFile));
		await fs.writeFile(
			projectFile,
			projectRows.length === 0 ? "" : `${projectRows.map((r) => r.raw).join("\n")}\n`,
		);
	}

	return { closed, created };
}

function parseSeeds(body: string): SeedRow[] {
	const out: SeedRow[] = [];
	for (const line of splitLines(body)) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const obj = parsed as Record<string, unknown>;
			const id = typeof obj.id === "string" ? obj.id : null;
			const status = typeof obj.status === "string" ? obj.status : null;
			const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : "";
			if (id === null || status === null) continue;
			out.push({ id, status, updatedAt, raw: line });
		} catch {
			// skip unparseable lines; we never want to corrupt the project's seeds file.
		}
	}
	return out;
}

/* ----------------------------------------------------------------------- */
/* Plans mirror (warren-d9a2)                                               */
/* ----------------------------------------------------------------------- */

/**
 * Mirror `.seeds/plans.jsonl` from the burrow workspace into the project
 * clone. Append-only: rows whose `id` is absent from the project baseline
 * are appended. Existing rows are never overwritten — plans are immutable
 * once submitted.
 */
export async function mirrorPlans(input: MirrorClosedSeedsInput): Promise<number> {
	const { burrowClient, burrowId, projectPath, fs, emit } = input;
	const projectFile = join(projectPath, ".seeds", "plans.jsonl");

	let burrowBody: string;
	try {
		const out = await withTransportMapping(burrowClient.config, () =>
			burrowClient.http.files.read(burrowId, ".seeds/plans.jsonl"),
		);
		burrowBody = out.contents;
	} catch (err) {
		if (err instanceof NotFoundError) return 0;
		throw err;
	}

	const projectBody = (await fs.readFile(projectFile)) ?? "";
	const projectIds = new Set<string>();
	const projectRows: { id: string; raw: string }[] = [];
	for (const line of splitLines(projectBody)) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const id = (parsed as Record<string, unknown>).id;
			if (typeof id === "string" && id.length > 0) {
				projectIds.add(id);
				projectRows.push({ id, raw: line });
			}
		} catch {
			// preserve unparseable lines
			projectRows.push({ id: "", raw: line });
		}
	}

	let added = 0;
	for (const line of splitLines(burrowBody)) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const id = (parsed as Record<string, unknown>).id;
			if (typeof id !== "string" || id.length === 0) continue;
			if (projectIds.has(id)) continue;
			projectRows.push({ id, raw: line });
			projectIds.add(id);
			added += 1;
			await emit("seeds.plan_mirrored", { id });
		} catch {
			// skip unparseable lines
		}
	}

	if (added > 0) {
		await fs.mkdirp(dirname(projectFile));
		await fs.writeFile(
			projectFile,
			projectRows.length === 0 ? "" : `${projectRows.map((r) => r.raw).join("\n")}\n`,
		);
	}

	return added;
}
