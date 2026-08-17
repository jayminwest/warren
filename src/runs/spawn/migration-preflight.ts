/**
 * Dispatch-time drizzle migration preflight (warren-1f03).
 *
 * Serial schema plans collided on drizzle migration journal slots: a branch
 * cut before main landed another migration regenerates its change at the
 * same journal index, and the PR merge then carries two entries with the
 * same idx (pl-103e needed a repair run per schema child). The DECISION
 * (2026-08-16) fixed the direction: detect the slot collision at dispatch
 * time and heal it prompt-free BEFORE the agent starts — delete the
 * branch's colliding migration artifacts, re-sync the journal to main's,
 * and re-run `bun run db:generate` so the branch's schema change is
 * regenerated at a slot past main's tip.
 *
 * Detection: parse the branch's `meta/_journal.json` entries against
 * `origin/<defaultBranch>`'s. A branch entry whose idx also exists on main
 * with a different tag (or whose tag exists on main at a different idx) is
 * a collision. The preflight only runs for ref-dispatches onto an existing
 * branch (`baseRef` resolved, host clone refreshed onto it) — a fresh
 * dispatch from the default branch cannot collide.
 *
 * Heal commits the regenerated migrations onto the checked-out branch of the
 * host clone with the canonical warren bot identity (Article VII,
 * src/bot-identity.ts) so the workspace fork the provider cuts from the
 * clone already carries the healed slot. The run event
 * `migration_journal_heal` (system stream) records the heal for operators.
 *
 * Rejected alternatives (per the DECISION): a journal-aware merge driver
 * (fixes it too late, more machinery) and the policy-only "use plan-run
 * mode" answer (pl-103e was already serial and still collided).
 */

import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type BotIdentityEnv,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "../../bot-identity.ts";
import type { Repos } from "../../db/repos/index.ts";
import { DEFAULT_GIT_TIMEOUT_MS, type SpawnFn } from "../../projects/clone.ts";

/** Default regeneration command — warren's package.json regenerates BOTH journals. */
export const DEFAULT_GENERATE_COMMAND: readonly string[] = ["bun", "run", "db:generate"];

/** Directory-name suffix that marks a drizzle journal path. */
const JOURNAL_SUFFIX = "meta/_journal.json";

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

export interface MigrationHealOutcome {
	/** Empty when no collision was detected (no-op). */
	readonly collisions: readonly JournalCollision[];
	/** Sha of the heal commit on the host clone branch; null when no heal ran. */
	readonly commitSha: string | null;
}

export interface MigrationHealInput {
	readonly spawn: SpawnFn;
	/** Host clone path (checked out to `baseRef` by the pre-dispatch refresh). */
	readonly projectPath: string;
	readonly defaultBranch: string;
	/** Branch the dispatch bases its workspace on. */
	readonly baseRef: string;
	/** Git binary; defaults to `git` (mirrors ProjectsConfig.gitBinary). */
	readonly gitBinary?: string;
	/** Regeneration command; defaults to `bun run db:generate`. */
	readonly generateCommand?: readonly string[];
	/** Env used to resolve the warren bot identity override; defaults to process.env. */
	readonly env?: BotIdentityEnv;
}

export type MigrationHealFn = (input: MigrationHealInput) => Promise<MigrationHealOutcome>;

interface Journal {
	readonly entries: readonly JournalEntry[];
	readonly [key: string]: unknown;
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function mustSpawn(
	spawn: SpawnFn,
	cmd: readonly string[],
	cwd: string,
	env?: Record<string, string | undefined>,
): Promise<string> {
	const result = await spawn(cmd, {
		cwd,
		timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
		...(env !== undefined ? { env } : {}),
	});
	if (result.exitCode !== 0) {
		throw new Error(`migration preflight: \`${cmd.join(" ")}\` failed: ${result.stderr.trim()}`);
	}
	return result.stdout;
}

/**
 * Heal one journal's collisions against main. Returns the collisions found
 * (empty ⇒ untouched). Heal = delete the branch's colliding artifacts,
 * re-sync the journal to main's entries (+ any non-colliding branch-only
 * entries at genuinely free slots past main's tip), and restore main-side
 * migration files the worktree lacks so the regenerate diffs against main's
 * tip snapshot instead of re-creating the colliding slot.
 */
async function healOneJournal(
	input: MigrationHealInput,
	git: string,
	originRef: string,
	journalPath: string,
): Promise<JournalCollision[]> {
	const branchRaw = await Bun.file(join(input.projectPath, journalPath))
		.text()
		.catch(() => null);
	const branch = branchRaw === null ? null : parseJournal(branchRaw);
	if (branch === null) return [];
	const mainShow = await input.spawn([git, "show", `${originRef}:${journalPath}`], {
		cwd: input.projectPath,
		timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
	});
	// No journal on main → nothing to collide with.
	if (mainShow.exitCode !== 0) return [];
	const main = parseJournal(mainShow.stdout);
	if (main === null) return [];

	const dir = journalPath.slice(0, -JOURNAL_SUFFIX.length - 1);
	const found = findCollisions(dir, branch.entries, main.entries);
	if (found.length === 0) return [];

	// Rebuild the branch journal as main's entries + any non-colliding
	// branch-only entries (a genuinely free slot past main's tip), sorted by idx.
	const collidingTags = new Set(found.map((c) => c.branchTag));
	const keptExtras = branch.entries
		.filter((e) => !collidingTags.has(e.tag))
		.filter((e) => !main.entries.some((m) => m.idx === e.idx || m.tag === e.tag));
	const merged = [...main.entries, ...keptExtras].sort((a, b) => a.idx - b.idx);

	// Delete the colliding migration artifacts (sql + snapshot).
	for (const tag of collidingTags) {
		await rm(join(input.projectPath, dir, `${tag}.sql`), { force: true });
		await rm(join(input.projectPath, dir, "meta", `${tag}_snapshot.json`), { force: true });
	}
	// Re-sync the journal to main + kept extras.
	await writeFile(
		join(input.projectPath, journalPath),
		`${JSON.stringify({ ...main, entries: merged }, null, "\t")}\n`,
	);
	// Restore any main-side migration files the branch worktree lacks so
	// the regenerate diffs against main's tip snapshot.
	for (const entry of main.entries) {
		for (const rel of [`${dir}/${entry.tag}.sql`, `${dir}/meta/${entry.tag}_snapshot.json`]) {
			const abs = join(input.projectPath, rel);
			if (await pathExists(abs)) continue;
			const content = await mustSpawn(
				input.spawn,
				[git, "show", `${originRef}:${rel}`],
				input.projectPath,
			);
			await writeFile(abs, content);
		}
	}
	return found;
}

/**
 * Detect journal-slot collisions between the checked-out branch and
 * `origin/<defaultBranch>` across every drizzle journal in the clone, and
 * heal any found by deleting the branch's colliding migration artifacts,
 * re-syncing the journal to main's (so regeneration lands past main's tip
 * instead of re-creating the colliding slot), re-running the generate
 * command, and committing the result on the host clone branch.
 *
 * Returns the collisions + heal commit sha; `{collisions: [], commitSha: null}`
 * when nothing collided (pure detection, no mutation).
 */
export const healMigrationJournalCollisions: MigrationHealFn = async (input) => {
	const git = input.gitBinary ?? "git";
	const originRef = `origin/${input.defaultBranch}`;

	// Discover every drizzle journal tracked in the clone.
	const listing = await mustSpawn(
		input.spawn,
		[git, "ls-files", "--", `:(glob)**/${JOURNAL_SUFFIX}`],
		input.projectPath,
	);
	const journalPaths = listing
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) => line !== "" && line.endsWith(JOURNAL_SUFFIX) && !line.includes("node_modules"),
		);

	const collisions: JournalCollision[] = [];
	const healedDirs: string[] = [];
	for (const journalPath of journalPaths) {
		const found = await healOneJournal(input, git, originRef, journalPath);
		if (found.length === 0) continue;
		collisions.push(...found);
		healedDirs.push(journalPath.slice(0, -JOURNAL_SUFFIX.length - 1));
	}
	if (collisions.length === 0) return { collisions, commitSha: null };

	// Prompt-free regeneration at the fresh slot (both journals).
	const generateCommand = input.generateCommand ?? DEFAULT_GENERATE_COMMAND;
	await mustSpawn(input.spawn, generateCommand, input.projectPath);

	// Commit the heal on the checked-out branch as the warren bot (Article VII).
	const env = input.env ?? process.env;
	await mustSpawn(input.spawn, [git, "add", "-A", "--", ...healedDirs], input.projectPath);
	await mustSpawn(
		input.spawn,
		[
			git,
			...warrenCommitIdentityArgs(env),
			"commit",
			"-m",
			`chore(warren): heal drizzle migration journal collision with ${input.defaultBranch}`,
		],
		input.projectPath,
		warrenCommitIdentityEnv(env),
	);
	const sha = (await mustSpawn(input.spawn, [git, "rev-parse", "HEAD"], input.projectPath)).trim();
	return { collisions, commitSha: sha === "" ? null : sha };
};

/**
 * Best-effort operator-visible record of a heal, appended to the run's event
 * stream (system kind, mirroring `seed-extensions.ts`'s recordEvent). Never
 * throws — a logging failure must not roll back an otherwise-healed dispatch.
 */
export async function recordMigrationHealEvent(
	repos: Repos,
	runId: string,
	outcome: MigrationHealOutcome,
	baseRef: string,
	now: Date,
): Promise<void> {
	try {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		await repos.events.append({
			runId,
			sandboxEventSeq: seq,
			ts: now.toISOString(),
			kind: "migration_journal_heal",
			stream: "system",
			payload: {
				baseRef,
				commitSha: outcome.commitSha,
				collisions: outcome.collisions,
			},
		});
	} catch {
		// Nothing left to surface; see seed-extensions recordEvent.
	}
}
