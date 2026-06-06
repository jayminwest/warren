/**
 * Built-in `leveret` agent definition (LEVERET.md §0.11 / §0.1 / §0.2,
 * build-phase 3 / warren-fdd9).
 *
 * Leveret is warren's conversational **overseer**: an agent that runs on
 * the `pi-chat` runtime (a long-lived, multi-turn pi session rather than
 * the one-shot batch runtime) and shapes a Plot's structured intent
 * through conversation. Unlike the batch coding built-ins it never edits
 * the workspace — its only structured side effect is the `propose_intent`
 * tool shipped by the extension below, which warren correlates host-side
 * (via the `tool_execution_end` stdout event's `toolCallId`) into an
 * `intent_edited(actor=leveret)` write against the active Plot.
 *
 * Runtime: `pi-chat`. `readRuntimeId` (src/registry/schema.ts) reads
 * `frontmatter.runtime` as a free string and forwards it onto burrow as
 * the runtime id — no `KNOWN_RUNTIME_IDS` change is required (§0.0.E).
 *
 * Safe by construction: the system prompt grants only read-leaning tools
 * (`read`/`grep`/`find`/`ls`/`bash`) — `bash` is the operator-trusted
 * overseer escape hatch — and explicitly withholds `edit`/`write`. With
 * no source-editing tool the send-off PR (warren-756d) can only ever
 * carry a plot-state update, never an arbitrary workspace diff.
 *
 * The single shipped pi extension `propose_intent` (seeded into
 * `.pi/extensions/propose_intent.ts` by src/runs/seed.ts, warren-e38b)
 * patches the STRUCTURED intent fields bound to the ../plot intent schema
 * (§0.14): `goal`, `non_goals`, `constraints`, `success_criteria`. It is
 * a field-scoped patch — NOT a free-form replace.
 *
 * Operators with a custom canopy library override this by registering a
 * same-named library agent — refresh upserts on top.
 */

import type { AgentDefinition } from "../schema.ts";
import { MODEL_TIERS } from "./model-tiers.ts";

const SYSTEM_BODY = `You are **Leveret**, the conversational overseer for a software project. Your job is to help a human shape a Plot's structured **intent** through conversation, then hand a clean, well-formed intent off to a planner.

You run as a long-lived chat session. Each user turn continues the same conversation — there is no per-turn respawn, so you keep context across the whole discussion.

You have read-leaning tools only:
- \`read\` — open a file.
- \`grep\` — search file contents.
- \`find\` / \`ls\` — explore the tree.
- \`bash\` — an operator-trusted escape hatch for read-only inspection (build/test introspection, git log, etc.).

You do NOT have \`edit\` or \`write\`. You cannot modify the workspace, and that is deliberate: the send-off PR carries only the Plot intent, never a source diff. Do not try to work around this by writing files through \`bash\` — treat the workspace as read-only.

The one structured side effect you have is the **\`propose_intent\`** tool. Call it whenever the conversation produces or revises one of the four intent fields:
- \`goal\` — a single-sentence description of what success looks like (overwrites the prior goal).
- \`non_goals\` — things explicitly out of scope (list; accumulates).
- \`constraints\` — hard requirements the work must respect (list; accumulates).
- \`success_criteria\` — measurable outcomes that prove the goal is met (list; accumulates).

Only pass the fields you are changing on a given call — \`propose_intent\` is a field-scoped patch, not a full replace. Omit a field entirely when you have nothing new for it; never ship empty placeholders.

Operating principles:
- Be concise. Ask one clarifying question at a time when you need information.
- Ground claims in what you have actually read; don't invent repo facts.
- Reflect the user's idea back in their own words before sharpening it.
- Drive the conversation toward all four intent fields, and call \`propose_intent\` as soon as the discussion settles one of them — don't batch everything to the end.
- The human, not you, decides when the intent is ready to send off. Don't dispatch downstream work; that belongs to other surfaces.

Workspace map:
- The project repo is mounted at the burrow workspace root.
- /workspace/.canopy/agent.json is this rendered agent definition.
- /workspace/.mulch/expertise/<domain>.jsonl holds the project's expertise records (read-only context for you).
- /workspace/.seeds/issues.jsonl holds the project's issue queue (read-only context for you).
- /workspace/.plot/ holds the active Plot's intent, attachments, and event log (read-only for you — propose changes via \`propose_intent\`, never by editing).
`;

/**
 * Source for the shipped `propose_intent` pi extension. Seeded verbatim
 * into `.pi/extensions/propose_intent.ts` (warren-e38b). It registers a
 * single tool whose `execute()` echoes the field-scoped intent patch on
 * the result's `details` — warren reads that off the
 * `tool_execution_end` stdout event and correlates by `toolCallId`
 * (§0.0.E) to write `intent_edited(actor=leveret)` host-side. The tool
 * does NOT touch `.plot/` itself; it is a pure proposal carrier.
 */
const PROPOSE_INTENT_EXTENSION = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * propose_intent — Leveret's only structured side effect.
 *
 * Registers a tool that proposes a field-scoped patch to the active
 * Plot's intent ({ goal?, non_goals?, constraints?, success_criteria? },
 * bound to the ../plot intent schema). The tool itself writes nothing:
 * it returns the patch on the result's \\\`details\\\`, which warren reads off
 * the \\\`tool_execution_end\\\` stdout event (correlated by toolCallId) and
 * turns into an intent_edited(actor=leveret) write host-side.
 */
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "propose_intent",
		label: "Propose Plot Intent",
		description:
			"Propose a field-scoped patch to the active Plot's structured intent. Pass only the fields you are changing; lists accumulate and goal overwrites. The host applies the patch — this tool does not edit files.",
		promptSnippet: "Propose changes to the Plot's goal / non_goals / constraints / success_criteria",
		promptGuidelines: [
			"Call propose_intent as soon as the conversation settles one of the four intent fields, passing only the fields you are changing.",
		],
		parameters: Type.Object({
			goal: Type.Optional(
				Type.String({ description: "Single-sentence goal; overwrites the prior goal." }),
			),
			non_goals: Type.Optional(
				Type.Array(Type.String(), { description: "Things explicitly out of scope (accumulates)." }),
			),
			constraints: Type.Optional(
				Type.Array(Type.String(), {
					description: "Hard requirements the work must respect (accumulates).",
				}),
			),
			success_criteria: Type.Optional(
				Type.Array(Type.String(), {
					description: "Measurable outcomes that prove the goal is met (accumulates).",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const patch: Record<string, unknown> = {};
			if (typeof params.goal === "string") patch.goal = params.goal;
			if (Array.isArray(params.non_goals)) patch.non_goals = params.non_goals;
			if (Array.isArray(params.constraints)) patch.constraints = params.constraints;
			if (Array.isArray(params.success_criteria)) {
				patch.success_criteria = params.success_criteria;
			}

			if (Object.keys(patch).length === 0) {
				throw new Error(
					"propose_intent requires at least one of goal, non_goals, constraints, success_criteria",
				);
			}

			const fields = Object.keys(patch).join(", ");
			return {
				content: [{ type: "text", text: \`Proposed intent patch for: \${fields}\` }],
				details: { intent_patch: patch },
			};
		},
	});
}
`;

export const LEVERET_BUILTIN: AgentDefinition = {
	name: "leveret",
	version: 1,
	sections: {
		system: SYSTEM_BODY,
		burrow_config: '[sandbox]\nnetwork = "open"\n',
		pi_extensions: JSON.stringify({ name: "propose_intent", body: PROPOSE_INTENT_EXTENSION }),
	},
	resolvedFrom: ["builtin:leveret"],
	frontmatter: {
		source: "builtin",
		tags: ["agent", "conversation"],
		// LEVERET.md §0.0.E: leveret dispatches onto the pi-chat runtime.
		// readRuntimeId reads frontmatter.runtime as a free string and
		// forwards it onto burrow — no KNOWN_RUNTIME_IDS change needed.
		runtime: "pi-chat",
		// Opus tier (model-tiers.ts): the overseer's conversation quality
		// shapes the Plot intent every downstream agent works from.
		...MODEL_TIERS.opus,
	},
};
