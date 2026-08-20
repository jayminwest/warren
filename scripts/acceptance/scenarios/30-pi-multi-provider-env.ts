/**
 * Scenario 30 — pi multi-provider env passthrough end-to-end
 * (warren-fe96 / burrow-6f3f).
 *
 * Acceptance criterion (warren-fe96):
 *   "Dispatching pi with providerOverride='openai' + OPENAI_API_KEY set
 *   in the warren container env results in the sandbox seeing
 *   OPENAI_API_KEY and pi successfully calling the OpenAI API."
 *
 * What this scenario proves end-to-end:
 *
 *   1. Warren's POST /runs accepts `providerOverride: "openai"`,
 *      folds it into the run's renderedAgentJson.frontmatter.provider
 *      (registry/schema.ts withProviderOverrides), and writes
 *      frontmatter into burrow's run metadata via composeBurrowMetadata
 *      (src/runs/spawn/dispatch.ts:composeBurrowMetadata).
 *   2. Burrow's dispatcher reads `Run.metadataJson.frontmatter`, calls
 *      `piEnvPassthrough({frontmatter})`, and unions the matching
 *      provider key (OPENAI_API_KEY for provider='openai') onto the
 *      per-spawn SandboxProfile.envPassthrough (burrow-6f3f, lifted
 *      into src/runtime/local/profile.ts).
 *   3. The engine's spawn step reads process.env for each name in
 *      profile.envPassthrough and forwards them into the agent's
 *      env — so OPENAI_API_KEY lands inside the stub process.
 *   4. The pi stub emits `{"type":"env_keys_visible","keys":[...]}`
 *      at startup; warren's bridge surfaces it as a `state_change`
 *      event with the original envelope preserved in `payload` (per
 *      pi parser's unknown-type fallthrough, burrow
 *      src/runtime/parsers/pi.ts:24-25).
 *   5. We assert the event payload's `keys` array includes
 *      OPENAI_API_KEY — closing the loop on the multi-provider
 *      passthrough contract.
 *
 * Why this is needed even though burrow has unit + dispatcher tests
 * for `piEnvPassthrough`: warren's contribution is the frontmatter
 * round-trip (operator override → renderedAgentJson → burrow run
 * metadata → dispatcher readFrontmatter). This scenario is the
 * end-to-end proof that the warren↔burrow handoff is intact across
 * the burrow-cli 0.3.3 bump.
 *
 * Boot mode: in-proc only — relies on the pi PATH shim
 * (lib/stub-agent/pi-path-shim.sh, warren-ea0a) and the profile's
 * frontmatter-conditional envPassthrough (src/runtime/local/profile.ts).
 * Container mode runs the real pi binary and is gated on a host with
 * valid provider credentials — out of scope here.
 */

import { join } from "node:path";

import { assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import { pollAcceptance } from "../lib/poll.ts";
import { collectRunEvents } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface RunRow {
	readonly id: string;
	readonly agentName: string;
	readonly sandboxId: string | null;
	readonly sandboxRunId: string | null;
	readonly renderedAgentJson: {
		readonly name: string;
		readonly frontmatter?: Record<string, unknown>;
	};
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly sandbox: { readonly id: string };
}

interface EventEnvelope {
	readonly id: number;
	readonly seq: number;
	readonly kind: string;
	readonly payload: unknown;
}

// Deterministic test key — value is irrelevant, the scenario only
// asserts the *name* was forwarded. Using a recognizable sentinel so
// stray logs are traceable.
const TEST_OPENAI_KEY = "sk-acceptance-25-not-a-real-key";
const ENV_EVENT_TIMEOUT_MS = 15_000;

export const scenario: Scenario = {
	id: "30",
	title:
		"pi multi-provider env passthrough — providerOverride='openai' surfaces OPENAI_API_KEY in the spawned sandbox",
	modes: ["in-proc"],
	async run(ctx) {
		// Boot a dedicated warren with OPENAI_API_KEY already in the child
		// process's env (warren-e376). The shared harness boot can't be
		// used: the engine's spawn reads warren's OWN process.env for each
		// name in profile.envPassthrough, and the shared warren was spawned
		// before any scenario ran — a process.env mutation here would never
		// reach it (that was the nightly failure: the key silently never
		// entered the sandbox).
		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(ctx.tmp, "warren-30"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath: ctx.fixtures.gitConfigPath,
				extraEnv: {
					OPENAI_API_KEY: TEST_OPENAI_KEY,
					// The internalized engine execs the bare name `pi`
					// (warren-ea0a) — inject the stub via PATH shim.
					PATH: `${ctx.fixtures.shimBinDir}:${process.env.PATH ?? ""}`,
				},
			});
			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });

			const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

			const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
				body: {
					agent: "pi",
					project: project.id,
					prompt: "scenario-30 pi multi-provider env passthrough",
					providerOverride: "openai",
					modelOverride: "gpt-4o",
				},
			});
			const run = created.run;

			// Sanity: warren folded the operator override onto the
			// frozen renderedAgentJson — without this, the dispatcher's
			// readFrontmatter has nothing to feed piEnvPassthrough.
			assertTrue(
				run.renderedAgentJson.frontmatter?.provider === "openai",
				`renderedAgentJson.frontmatter.provider should be 'openai'; got ${JSON.stringify(run.renderedAgentJson.frontmatter?.provider)}`,
			);

			try {
				const visible = await waitForEnvKeysVisible(http, run.id, ENV_EVENT_TIMEOUT_MS);
				assertTrue(
					visible.includes("OPENAI_API_KEY"),
					`spawned pi stub should see OPENAI_API_KEY in env (proves dispatcher unioned the provider key into envPassthrough); got keys=${JSON.stringify(visible)}`,
				);
			} finally {
				await safelyCancel(http, run.id);
			}
		} finally {
			await handle?.stop();
		}
	},
};

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const existing = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const found = existing.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return found;
	return await http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

/**
 * Stream events until we find the `env_keys_visible` envelope the pi
 * stub emits at startup (collapsed to `state_change` by the parser).
 * Returns the list of env var names the stub observed in its env.
 */

/**
 * Stream events until we find the `env_keys_visible` envelope the pi
 * stub emits at startup (collapsed to `state_change` by the parser).
 * Returns the list of env var names the stub observed in its env.
 */
async function waitForEnvKeysVisible(
	http: WarrenHttp,
	runId: string,
	timeoutMs: number,
): Promise<readonly string[]> {
	return pollAcceptance({
		label: "env_keys_visible event",
		id: runId,
		timeoutMs,
		intervalMs: 100,
		fetchRow: async (): Promise<readonly string[] | null> => {
			const events = await collectRunEvents<EventEnvelope>(http, runId);
			for (const ev of events) {
				const payload = ev.payload as { type?: unknown; keys?: unknown } | null | undefined;
				if (
					ev.kind === "state_change" &&
					payload !== null &&
					payload !== undefined &&
					payload.type === "env_keys_visible" &&
					Array.isArray(payload.keys)
				) {
					return payload.keys.filter((k): k is string => typeof k === "string");
				}
			}
			return null;
		},
		isDone: (keys): keys is readonly string[] => keys !== null,
		describe: (keys) => (keys === null ? "not seen yet" : `${keys.length} keys`),
	});
}

async function safelyCancel(http: WarrenHttp, runId: string): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch {
		// best-effort
	}
}
