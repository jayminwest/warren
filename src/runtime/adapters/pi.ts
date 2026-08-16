/**
 * The `pi` adapter (warren-c80e phase 1; harness hooks source-lifted from
 * burrow's `src/runtime/pi.ts` in warren-7933, plan pl-3007).
 *
 * Pi's `--mode rpc` reads one JSON command per `\n`-delimited line on
 * stdin and emits one JSON event per line on stdout. Each run writes a
 * single `{"type":"prompt","message":"<prompt + steering prefix>"}` line
 * and then waits for the agent to drain. The parser in
 * `./parsers/pi.ts` collapses pi's wider event vocabulary into the stable
 * taxonomy (burrow SPEC §14.1) — the adapter here owns argv, stdin
 * payload, and the workspace hooks.
 *
 * Critical dispatcher invariant (mx-d9b3ad, from the captured fixtures):
 * pi exits the instant stdin closes, even mid-inference. The adapter
 * declares `shouldCloseStdinOnEvent` returning true for `agent_end`,
 * which tells the dispatcher to write the prompt + hold stdin open, then
 * close it only after pi has emitted its terminal lifecycle envelope.
 * Real e2e runs without this hook produce only
 * response+agent_start+turn_start and exit 0 with no assistant content
 * (burrow-5db3).
 *
 * Mid-run steering (burrow SPEC §13.5, burrow-250d): because stdin is
 * held open until `agent_end`, the dispatcher can route inbox messages
 * arriving during an in-flight turn directly to pi by writing additional
 * `{"type":"prompt",...}` lines through the still-open stdin. The
 * adapter exposes that encoding via `encodeSteeringMessage`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parsePiEvents } from "./parsers/pi.ts";
import { buildPiArgv, PI_SESSION_DIR } from "./pi-argv.ts";
import { readNewestPiSessionId } from "./pi-session.ts";
import {
	encodeExtensionUiDecline,
	encodePiStdin,
	isPiExtensionUiRequest,
	piPromptCommandFromMessage,
} from "./pi-stdin.ts";
import type {
	AdapterExtractMetadataContext,
	AdapterPrepareContext,
	AdapterRuntimeEvent,
	AdapterSpawnContext,
	AgentRuntimeAdapter,
	SpawnCommand,
	SteeringMessage,
} from "./types.ts";

export const piAdapter: AgentRuntimeAdapter = {
	runtimeId: "pi",
	/**
	 * `.pi/sessions/` only, NOT `.pi/`.
	 *
	 * The parent directory is shared between two different kinds of writer.
	 * `.pi/skills/<name>/SKILL.md` and `.pi/prompts/<name>.md` are
	 * materialized by warren from the agent definition's `pi_skills` /
	 * `pi_prompts` (see docs/design/agent-composition.md), so they are
	 * composition output rather than harness scratch, and treating them as
	 * ignorable would weaken the dropped-commit guard against warren's own
	 * writes. `.pi/sessions/` is the harness's own transcript: the 0.9.x
	 * changelog records removing "a stray `.pi/sessions` agent transcript
	 * committed by PR #340" (warren-4c8d), which is exactly the
	 * harness-wrote-it-and-nobody-staged-it shape this list is for.
	 */
	harnessStatePrefixes: [".pi/sessions/"],
	/**
	 * pi attaches the terminal error signal to either the per-turn
	 * (`turn_end`) or the run-terminal (`agent_end`) envelope depending on
	 * which provider error path fired, so both are read (warren-edc3,
	 * warren-e281). This pair is the set `classifyEnvelope` hardcoded before
	 * the seam existed, moved verbatim.
	 */
	terminalErrorEnvelopeTypes: ["turn_end", "agent_end"],

	buildSpawnCommand(ctx: AdapterSpawnContext): SpawnCommand {
		return {
			argv: buildPiArgv(ctx.frontmatter),
			stdin: encodePiStdin(ctx.prompt, ctx.pendingMessages),
		};
	},

	parseEvents(line: string): AdapterRuntimeEvent[] {
		return parsePiEvents(line);
	},

	/**
	 * pi v0.74.0 exits the instant stdin closes (mx-d9b3ad), so the
	 * dispatcher must hold stdin open until the run actually finishes.
	 * `agent_end` is pi's terminal lifecycle envelope (collapsed by the
	 * parser to `state_change` on `system` with the raw envelope preserved
	 * in `payload`); closing stdin on that signal lets pi exit cleanly
	 * through its RPC read loop instead of being killed mid-inference.
	 */
	shouldCloseStdinOnEvent(event: AdapterRuntimeEvent): boolean {
		if (event.kind !== "state_change") return false;
		const payload = event.payload as { type?: unknown } | null | undefined;
		return !!payload && payload.type === "agent_end";
	},

	/**
	 * If a run opts into extensions through `frontmatter.pi.extensions`,
	 * keep the batch runtime hang-safe by auto-declining any interactive
	 * extension UI prompt. Runs with the default `--no-extensions` argv
	 * never see this event.
	 */
	autoRespondToEvent(event: AdapterRuntimeEvent): { stdin: string } | undefined {
		if (!isPiExtensionUiRequest(event)) return undefined;
		return { stdin: encodeExtensionUiDecline(event.payload) };
	},

	encodeInboxMessage(messages: readonly SteeringMessage[]): { stdin: string } {
		return { stdin: messages.map((m) => `${piPromptCommandFromMessage(m)}\n`).join("") };
	},

	/**
	 * Mid-run steering (burrow SPEC §13.5, burrow-250d). Pi's `--mode rpc`
	 * reads one JSON command per `\n`-delimited line from stdin, so an
	 * in-flight agent can be steered by writing additional
	 * `{"type":"prompt",...}` envelopes to the still-open sink (the
	 * stdin-hold path established by burrow-5db3 keeps the FD live until
	 * `agent_end`). Pi's RPC vocabulary is pinned to `prompt` here for the
	 * same reason `encodeInboxMessage` uses it — that's the only command
	 * shape proven against the captured fixtures; if a later pi version
	 * exposes a dedicated `steer` / `follow_up` command this is the one
	 * place to bump.
	 */
	encodeSteeringMessage(message: SteeringMessage): { stdin: string } {
		return { stdin: `${piPromptCommandFromMessage(message)}\n` };
	},

	async prepareWorkspace(ctx: AdapterPrepareContext): Promise<void> {
		mkdirSync(join(ctx.workspacePath, PI_SESSION_DIR), { recursive: true });
	},

	async extractMetadata(
		ctx: AdapterExtractMetadataContext,
	): Promise<Record<string, unknown> | undefined> {
		const sessionId = readNewestPiSessionId(join(ctx.workspacePath, PI_SESSION_DIR));
		return sessionId ? { session_id: sessionId } : undefined;
	},
};
