import type { WarrenDb } from "../../db/client.ts";
import { openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { AgentDefinition } from "../../registry/schema.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { FakeProvider, type FakeProviderCall } from "../../runtime/fake/fake-provider.ts";

/**
 * Open an in-memory warren db with a default `refactor-bot` agent and
 * one project (`prj_xxxxxxxxxxxx`) seeded. Used by every spawn test
 * file — keeps the per-file beforeEach short.
 */
export async function setupRepos(): Promise<{ db: WarrenDb; repos: Repos }> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: makeAgentJson() });
	await repos.projects.create({
		id: "prj_xxxxxxxxxxxx",
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	return { db, repos };
}

/**
 * The provider seam for the provider-only spawn path (warren-c42c; re-based
 * onto the contract-typed `FakeProvider` in warren-ea0a when the burrow
 * facade left). `spawnRun` dispatches through `runtimeProvider.create()`, so
 * spawn tests hand the fake straight through — behavior is identical to the
 * old dispatch fallback.
 */
export function makeProvider(client: RuntimeProvider): RuntimeProvider {
	return client;
}

// `typeof fetch` requires a `preconnect` method we don't exercise in tests; cast
// each stub so callers can pass a plain async function.
export function stub(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return impl as unknown as typeof fetch;
}

export interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
}

/**
 * Failure plan for the fake provider (warren-ea0a). Named after the
 * historical burrow HTTP stub so the spawn tests read unchanged: a non-2xx
 * `sandboxUpStatus` fails the provision half of `create`;
 * `runsCreateStatus` fails the dispatch half (after the fake records the
 * legacy self-rollback DELETE, exactly as the retired legacy mode did). The
 * thrown error's message comes from the body's `error.message` — several
 * rollback tests assert on it.
 */
export interface BurrowFetchPlan {
	sandboxUpStatus?: number;
	sandboxUpBody?: unknown;
	runsCreateStatus?: number;
	runsCreateBody?: unknown;
}

/** Pull the `error.message` out of a canned failure body, if it carries one. */
function planErrorMessage(body: unknown, fallback: string): string {
	if (typeof body === "object" && body !== null) {
		const message = (body as { error?: { message?: unknown } }).error?.message;
		if (typeof message === "string") return message;
	}
	return fallback;
}

export function makeSandboxClient(plan: BurrowFetchPlan = {}): {
	client: FakeProvider;
	calls: FakeProviderCall[];
} {
	const provisionError =
		plan.sandboxUpStatus !== undefined && plan.sandboxUpStatus >= 300
			? new Error(planErrorMessage(plan.sandboxUpBody, `provision failed ${plan.sandboxUpStatus}`))
			: undefined;
	const dispatchError =
		plan.runsCreateStatus !== undefined && plan.runsCreateStatus >= 300
			? new Error(planErrorMessage(plan.runsCreateBody, `dispatch failed ${plan.runsCreateStatus}`))
			: undefined;
	const client = new FakeProvider({
		...(provisionError !== undefined ? { provisionError } : {}),
		...(dispatchError !== undefined ? { dispatchError } : {}),
	});
	return { client, calls: client.calls };
}

/**
 * Pull `.warren/agent.json` out of the seed payload recorded on the
 * provision call and return its `frontmatter`. The seed payload travels as
 * part of `create`'s workspace mapping (`seed.files`), so the agent envelope
 * is recoverable from the recorded call body without a separate seam.
 */
export function readAgentEnvelopeFrontmatter(
	calls: readonly RecordedCall[],
): Record<string, unknown> {
	const up = calls.find((c) => c.method === "POST" && c.path === "/sandboxes");
	const seed = (
		up?.body as { seed?: { files?: ReadonlyArray<{ path: string; contents: string }> } }
	)?.seed;
	const envelope = seed?.files?.find((f) => f.path === ".warren/agent.json");
	if (envelope === undefined) throw new Error(".warren/agent.json missing from seed payload");
	const parsed = JSON.parse(envelope.contents) as { frontmatter?: Record<string, unknown> };
	return parsed.frontmatter ?? {};
}

export function makeAgentJson(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "refactor-bot",
		version: 1,
		sections: {
			system: "be a refactor agent",
			...(overrides.sections ?? {}),
		},
		resolvedFrom: [],
		frontmatter: {},
		...overrides,
	};
}
