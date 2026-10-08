/**
 * Run-row seeding for the ui-visual fixture boot (warren-010b): the frozen
 * clock, the fixed-id helper, and `seedRun`, which walks one run through
 * the legal lifecycle edges its spec names. Every timestamp derives from
 * {@link FIXTURE_NOW_MS}; `fixture-data.ts` composes these into the fixture.
 */

import type { RunFailureReason } from "../../src/core/wire.ts";
import type { Repos } from "../../src/db/repos/index.ts";
import { BUILTIN_AGENTS } from "../../src/registry/builtins/index.ts";
import { FIXTURE_CONSTANTS } from "../acceptance/lib/fixtures.ts";

/** The frozen instant: server `now`, and what the harness pins the browser to. */
export const FIXTURE_NOW_ISO = "2026-09-15T12:00:00.000Z";
export const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW_ISO);
/** Fixed operator token; the harness seeds localStorage `warren.apiToken` with it. */
export const FIXTURE_TOKEN = "warren-ui-visual-fixture-token";

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** `FIXTURE_NOW` minus `minutes`, as a Date. */
export function minutesAgo(minutes: number): Date {
	return new Date(FIXTURE_NOW_MS - minutes * MINUTE_MS);
}

/** `<prefix>_fx<10 digits>`: a valid 12-char base32 id suffix. */
export function fxId(prefix: string, n: number): string {
	return `${prefix}_fx${String(n).padStart(10, "0")}`;
}

export const OWNER = FIXTURE_CONSTANTS.projectOwner;
export const SEEDS_REPO = FIXTURE_CONSTANTS.projectRepo;

export interface RunSpec {
	readonly id: string;
	readonly projectId: string;
	readonly agent: "claude-code" | "pi";
	readonly prompt: string;
	readonly trigger: string;
	readonly seedId?: string;
	/** Minutes before FIXTURE_NOW for each lifecycle edge (undefined = never). */
	readonly createdMin: number;
	readonly startedMin?: number;
	readonly endedMin?: number;
	readonly terminal?: "succeeded" | "failed" | "cancelled";
	readonly failureReason?: RunFailureReason;
	readonly costUsd?: number;
	readonly prNumber?: number;
	readonly prState?: "open" | "merged" | "closed_unmerged";
	readonly filesChanged?: number;
}

export const AGENT_JSON = new Map(
	BUILTIN_AGENTS.filter((a) => a.name === "claude-code" || a.name === "pi").map((a) => [a.name, a]),
);
const PROVIDER_MODEL = {
	"claude-code": { provider: "anthropic", model: "claude-sonnet-4-5" },
	pi: { provider: "openai", model: "gpt-5" },
} as const;

export function prUrlFor(n: number): string {
	return `https://github.com/${OWNER}/${SEEDS_REPO}/pull/${n}`;
}

/** Create one run and walk it through the legal lifecycle edges its spec names. */
export async function seedRun(repos: Repos, spec: RunSpec): Promise<void> {
	const pm = PROVIDER_MODEL[spec.agent];
	await repos.runs.create({
		id: spec.id,
		agentName: spec.agent,
		projectId: spec.projectId,
		prompt: spec.prompt,
		renderedAgentJson: AGENT_JSON.get(spec.agent) ?? {},
		trigger: spec.trigger,
		...(spec.seedId !== undefined ? { seedId: spec.seedId } : {}),
		provider: pm.provider,
		model: pm.model,
		now: minutesAgo(spec.createdMin),
	});
	if (spec.startedMin === undefined) return;
	const started = minutesAgo(spec.startedMin);
	await repos.runs.markWorkspaceReady(spec.id, new Date(started.getTime() - 20_000));
	await repos.runs.markRunning(spec.id, started);
	await repos.runs.setBranch(spec.id, `warren/${spec.id}`);
	if (spec.costUsd !== undefined) await attachSpecStats(repos, spec.id, spec.costUsd);
	if (spec.terminal === undefined || spec.endedMin === undefined) return;
	await settleRun(repos, spec, spec.terminal, minutesAgo(spec.endedMin));
}

/** Cost plus tokens derived from it, so the token panels stay proportional. */
async function attachSpecStats(repos: Repos, id: string, costUsd: number): Promise<void> {
	const tokensInput = Math.round(costUsd * 180_000);
	await repos.runs.attachStats(id, {
		costUsd,
		tokensInput,
		tokensOutput: Math.round(tokensInput / 9),
		tokensCacheRead: tokensInput * 4,
		tokensCacheWrite: Math.round(tokensInput / 3),
	});
}

/** The terminal edge plus the reap-time facts: outcome facts, PR url, PR state. */
async function settleRun(
	repos: Repos,
	spec: RunSpec,
	terminal: NonNullable<RunSpec["terminal"]>,
	ended: Date,
): Promise<void> {
	await repos.runs.markAgentEnded(spec.id, new Date(ended.getTime() - 15_000));
	await repos.runs.finalize(spec.id, terminal, ended, spec.failureReason ?? null);
	await repos.runs.markReaped(spec.id, ended);
	if (spec.filesChanged !== undefined) {
		await repos.runs.setOutcomeFacts(spec.id, {
			commitsAhead: spec.filesChanged > 0 ? 2 : 0,
			baseSha: "4be1f2a9c0d3e5f60718293a4b5c6d7e8f901234",
			filesChanged: spec.filesChanged,
			insertions: spec.filesChanged * 23,
			deletions: spec.filesChanged * 7,
		});
	}
	if (spec.prNumber === undefined) return;
	await repos.runs.setPrUrl(spec.id, prUrlFor(spec.prNumber));
	if (spec.prState === undefined) return;
	const mergedAt = spec.prState === "merged" ? new Date(ended.getTime() + 40 * MINUTE_MS) : null;
	await repos.runs.setPrState(spec.id, spec.prState, mergedAt?.toISOString() ?? null);
}
