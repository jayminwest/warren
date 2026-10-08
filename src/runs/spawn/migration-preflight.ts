/**
 * Dispatch-time drizzle migration journal preflight (warren-1f03, warren-4371).
 *
 * Serial schema plans collided on drizzle migration journal slots: a branch
 * cut before main landed another migration regenerates its change at the
 * same journal index, and the PR merge then carries two entries with the
 * same idx (pl-103e needed a repair run per schema child).
 *
 * Detection: parse the branch's `meta/_journal.json` entries against
 * `origin/<defaultBranch>`'s. A branch entry whose idx also exists on main
 * with a different tag (or whose tag exists on main at a different idx) is
 * a collision. The preflight only runs for ref-dispatches onto an existing
 * branch (`baseRef` resolved, host clone refreshed onto it) — a fresh
 * dispatch from the default branch cannot collide.
 *
 * Trust boundary (warren-4371): the preflight runs in the control plane, so
 * it is DETECTION ONLY. It reads the working-tree journal file and runs two
 * read-only git plumbing commands (`git ls-files`, `git cat-file blob`). It
 * never executes a repository-defined script, never writes to the host
 * clone, and never commits. The warren-1f03 heal ran the repository's own
 * generate script and committed on the host clone, which executed
 * repository code outside the run's isolation boundary with the control
 * plane's environment. Regeneration now happens inside the run's sandbox:
 * a detected collision is surfaced to the agent as a prompt note (quoting
 * the project's optional `migrations.regenerateCommand` from
 * `.warren/config.yaml`) and recorded as a `migration_journal_collision`
 * system event for operators. See SECURITY.md "Runtime isolation".
 */

import { join } from "node:path";
import { WarrenError } from "../../core/errors.ts";
import type { Repos } from "../../db/repos/index.ts";
import { DEFAULT_GIT_TIMEOUT_MS, type SpawnFn } from "../../projects/clone.ts";

/** Directory-name suffix that marks a drizzle journal path. */
const JOURNAL_SUFFIX = "meta/_journal.json";

/** Run event kind recording a detected collision (system stream). */
export const MIGRATION_COLLISION_EVENT_KIND = "migration_journal_collision";

/** Typed preflight failure (warren-236d): maps to HTTP 409 — the host clone's journals could not be listed. */
export class MigrationPreflightError extends WarrenError {
	readonly code = "migration_preflight_failed";

	constructor(message: string) {
		super(message, {
			recoveryHint:
				"warren could not read the branch's drizzle migration journals from the project clone; refresh the project and re-dispatch",
		});
		this.name = "MigrationPreflightError";
	}
}

export interface JournalEntry {
	readonly idx: number;
	readonly tag: string;
}

export interface JournalCollision {
	/** Repo-relative migrations dir (`src/db/migrations` / `.../postgres`). */
	readonly migrationsDir: string;
	readonly idx: number;
	readonly branchTag: string;
	readonly mainTag: string;
}

export interface MigrationPreflightOutcome {
	/** Empty when no collision was detected. */
	readonly collisions: readonly JournalCollision[];
}

export interface MigrationPreflightInput {
	readonly spawn: SpawnFn;
	/** Host clone path (checked out to `baseRef` by the pre-dispatch refresh). */
	readonly projectPath: string;
	readonly defaultBranch: string;
	/** Branch the dispatch bases its workspace on. */
	readonly baseRef: string;
	/** Git binary; defaults to `git` (mirrors ProjectsConfig.gitBinary). */
	readonly gitBinary?: string;
}

export type MigrationPreflightFn = (
	input: MigrationPreflightInput,
) => Promise<MigrationPreflightOutcome>;

interface Journal {
	readonly entries: readonly JournalEntry[];
}

/** Parse a drizzle journal. Returns null when the shape isn't a journal. */
function parseJournal(raw: string): Journal | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const entries = (parsed as { entries?: unknown }).entries;
	if (!Array.isArray(entries)) return null;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) return null;
		const { idx, tag } = entry as { idx?: unknown; tag?: unknown };
		if (typeof idx !== "number" || typeof tag !== "string") return null;
	}
	return parsed as Journal;
}

/** Collisions between a branch journal and main's, per the DECISION rule. */
export function findCollisions(
	migrationsDir: string,
	branch: readonly JournalEntry[],
	main: readonly JournalEntry[],
): JournalCollision[] {
	const mainByIdx = new Map<number, string>();
	const mainIdxByTag = new Map<string, number>();
	for (const entry of main) {
		mainByIdx.set(entry.idx, entry.tag);
		mainIdxByTag.set(entry.tag, entry.idx);
	}
	const out: JournalCollision[] = [];
	for (const entry of branch) {
		const tagAtIdx = mainByIdx.get(entry.idx);
		const idxOfTag = mainIdxByTag.get(entry.tag);
		const idxClash = tagAtIdx !== undefined && tagAtIdx !== entry.tag;
		const tagClash = idxOfTag !== undefined && idxOfTag !== entry.idx;
		if (idxClash || tagClash) {
			out.push({
				migrationsDir,
				idx: entry.idx,
				branchTag: entry.tag,
				mainTag: tagAtIdx ?? entry.tag,
			});
		}
	}
	return out;
}

/** Collisions in one journal; empty when either side has no parseable journal. */
async function detectOneJournal(
	input: MigrationPreflightInput,
	git: string,
	originRef: string,
	journalPath: string,
): Promise<JournalCollision[]> {
	const branchRaw = await Bun.file(join(input.projectPath, journalPath))
		.text()
		.catch(() => null);
	const branch = branchRaw === null ? null : parseJournal(branchRaw);
	if (branch === null) return [];
	// Plumbing read of the blob: no textconv, no filters, no hooks.
	const mainBlob = await input.spawn([git, "cat-file", "blob", `${originRef}:${journalPath}`], {
		cwd: input.projectPath,
		timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
	});
	// No journal on main → nothing to collide with.
	if (mainBlob.exitCode !== 0) return [];
	const main = parseJournal(mainBlob.stdout);
	if (main === null) return [];
	const dir = journalPath.slice(0, -JOURNAL_SUFFIX.length - 1);
	return findCollisions(dir, branch.entries, main.entries);
}

/**
 * Detect journal-slot collisions between the checked-out branch and
 * `origin/<defaultBranch>` across every drizzle journal tracked in the clone.
 * Read-only: the host clone is never mutated and no repository-defined
 * command runs (warren-4371).
 */
export const detectMigrationJournalCollisions: MigrationPreflightFn = async (input) => {
	const git = input.gitBinary ?? "git";
	const originRef = `origin/${input.defaultBranch}`;
	const listing = await input.spawn([git, "ls-files", "--", `:(glob)**/${JOURNAL_SUFFIX}`], {
		cwd: input.projectPath,
		timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
	});
	if (listing.exitCode !== 0) {
		throw new MigrationPreflightError(
			`migration preflight: \`git ls-files\` failed: ${listing.stderr.trim()}`,
		);
	}
	const journalPaths = listing.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) => line !== "" && line.endsWith(JOURNAL_SUFFIX) && !line.includes("node_modules"),
		);
	const collisions: JournalCollision[] = [];
	for (const journalPath of journalPaths) {
		collisions.push(...(await detectOneJournal(input, git, originRef, journalPath)));
	}
	return { collisions };
};

/**
 * The agent-facing note for a detected collision. The run repairs the
 * migrations inside its own sandbox. `regenerateCommand` is the project's
 * `.warren/config.yaml` `migrations.regenerateCommand`, quoted as guidance
 * only — warren never executes it.
 */
export function composeMigrationCollisionNote(
	collisions: readonly JournalCollision[],
	defaultBranch: string,
	regenerateCommand: string | undefined,
): string {
	const main = `origin/${defaultBranch}`;
	const lines = collisions.map(
		(c) =>
			`- \`${c.migrationsDir}\`: branch migration \`${c.branchTag}\` (idx ${c.idx}) collides with \`${c.mainTag}\` on \`${main}\``,
	);
	const regenerate =
		regenerateCommand !== undefined
			? `run \`${regenerateCommand}\``
			: "run this project's migration generator";
	return [
		"## Migration journal collision (detected by warren at dispatch)",
		"",
		`This branch's generated migration journal collides with \`${main}\`, which landed migrations at the same journal slot after the branch was cut. Warren did not modify the branch. Repair it inside this workspace before finishing:`,
		"",
		...lines,
		"",
		`Bring in \`${main}\`'s migrations and journal, delete the branch's colliding migration artifacts (the \`.sql\` file and its \`meta/<idx>_snapshot.json\`), then ${regenerate} so the branch's schema change lands past the default branch's tip, and commit the result.`,
	].join("\n");
}

/** Append the collision note to the composed dispatch prompt (same `---` delimiter as composeDispatchPrompt). */
export function appendMigrationCollisionNote(prompt: string, note: string | null): string {
	return note === null ? prompt : `${prompt}\n\n---\n\n${note}`;
}

export interface DispatchMigrationPreflightArgs {
	readonly detect: MigrationPreflightFn;
	readonly input: MigrationPreflightInput;
	readonly regenerateCommand: string | undefined;
	readonly repos: Repos;
	readonly runId: string;
	readonly now: Date;
	readonly logInfo: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Dispatch-side wrapper: run detection and, when a collision is found, log
 * it, record the operator-visible event, and return the agent prompt note
 * (null ⇒ nothing to surface).
 */
export async function runDispatchMigrationPreflight(
	args: DispatchMigrationPreflightArgs,
): Promise<string | null> {
	const { collisions } = await args.detect(args.input);
	if (collisions.length === 0) return null;
	args.logInfo({ collisions, base_ref: args.input.baseRef }, "spawn.migration_journal_collision");
	await recordMigrationCollisionEvent(args.repos, args.runId, {
		baseRef: args.input.baseRef,
		collisions,
		regenerateCommand: args.regenerateCommand ?? null,
		now: args.now,
	});
	return composeMigrationCollisionNote(
		collisions,
		args.input.defaultBranch,
		args.regenerateCommand,
	);
}

/**
 * Best-effort operator-visible record of a detected collision, appended to
 * the run's event stream (system kind, mirroring `seed-extensions.ts`'s
 * recordEvent). Never throws — a logging failure must not roll back an
 * otherwise-valid dispatch.
 */
export async function recordMigrationCollisionEvent(
	repos: Repos,
	runId: string,
	record: {
		readonly baseRef: string;
		readonly collisions: readonly JournalCollision[];
		readonly regenerateCommand: string | null;
		readonly now: Date;
	},
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: record.now.toISOString(),
			kind: MIGRATION_COLLISION_EVENT_KIND,
			stream: "system",
			payload: {
				baseRef: record.baseRef,
				collisions: record.collisions,
				regenerateCommand: record.regenerateCommand,
				resolution: "agent_in_sandbox",
			},
		});
	} catch {
		// Nothing left to surface; see seed-extensions recordEvent.
	}
}
