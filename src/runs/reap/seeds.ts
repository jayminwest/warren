import { dirname, join } from "node:path";
import type { EventRow } from "../../db/schema.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import type { ReapFs } from "./types.ts";
import { splitLines } from "./util.ts";

/* -----------------------------------------------------------------------
 * warren-fbbf: these mirror primitives are PURE string→disk merges. The burrow
 * file-read that used to live here (`sandboxClient.http.files.read`) was evicted
 * to the LocalProvider (`src/runtime/local/finalize.ts`), which is the ONE place
 * warren still speaks the burrow dialect. finalize reads the workspace tracker
 * body off the live sandbox and hands it in as `workspaceBody`; this module only
 * merges it into the project clone. `workspaceBody === null` is the
 * "agent-never-created-the-file" shape (was the `NotFoundError` branch) — a
 * no-op, never an error.
 * --------------------------------------------------------------------- */

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
	/**
	 * The workspace-side tracker body the LocalProvider read off the live burrow
	 * (`.seeds/issues.jsonl` for {@link mirrorSeeds}, `.seeds/plans.jsonl` for
	 * {@link mirrorPlans}). `null` when the file was absent in the workspace —
	 * the agent never created it — which is a clean no-op, not a failure.
	 */
	readonly workspaceBody: string | null;
	readonly projectPath: string;
	readonly fs: ReapFs;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

interface MirrorSeedsResult {
	readonly closed: number;
	readonly created: number;
}

export async function mirrorSeeds(input: MirrorClosedSeedsInput): Promise<MirrorSeedsResult> {
	const { workspaceBody, projectPath, fs, emit } = input;
	if (workspaceBody === null) return { closed: 0, created: 0 };
	const projectFile = join(projectPath, ".seeds", "issues.jsonl");
	const sandboxBody = workspaceBody;

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

	for (const incoming of parseSeeds(sandboxBody)) {
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
 * Mirror `.seeds/plans.jsonl` from the workspace body into the project
 * clone. Append-only: rows whose `id` is absent from the project baseline
 * are appended. Existing rows are never overwritten — plans are immutable
 * once submitted.
 */
export async function mirrorPlans(input: MirrorClosedSeedsInput): Promise<number> {
	const { workspaceBody, projectPath, fs, emit } = input;
	if (workspaceBody === null) return 0;
	const projectFile = join(projectPath, ".seeds", "plans.jsonl");
	const sandboxBody = workspaceBody;

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
	for (const line of splitLines(sandboxBody)) {
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

/* ----------------------------------------------------------------------- */
/* Host-side seed-id close (warren-0d2d)                                   */
/* ----------------------------------------------------------------------- */

export interface CloseRunSeedIdInput {
	readonly seedId: string;
	readonly projectId: string;
	readonly projectPath: string;
	readonly issueTracker: IssueTracker;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

/**
 * Host-side safety net: close the dispatched run's associated seed after a
 * successful reap. Runs *after* `mirrorSeeds` so any workspace-side close
 * the agent performed is already reflected in the project clone.
 *
 * If the seed was already closed (agent closed it + mirrorSeeds picked it
 * up), closing is idempotent (tracker.closeIssue contract) — the extra call
 * is harmless. `stageSeedsForCommit` will pick up the updated issues.jsonl
 * and author a `chore(warren): seeds state` commit on the branch so the
 * close appears in git history whether the agent ran `sd close` or not.
 *
 * warren-6234: routed through the IssueTracker seam (`tracker.closeIssue`)
 * instead of the seeds CLI facade.
 */
export async function closeRunSeedId(input: CloseRunSeedIdInput): Promise<boolean> {
	const { seedId, projectId, projectPath, issueTracker, emit } = input;
	await issueTracker.closeIssue({ projectId, localPath: projectPath }, seedId);
	await emit("seeds.seed_id_closed", { id: seedId, mode: "host_side" });
	return true;
}
