/**
 * Rubric v1 authoring: the judge system prompt and the rubric-version hash.
 *
 * The taxonomy text renders the fifteen classes of agent-analytics §12.4
 * (owner cut 2026-08-15) verbatim in meaning, with per-class definitions and
 * the evidence-pointability instructions the §12.3 verdict shape demands.
 * The class vocabulary itself comes from `wire.ts`, the locked artifact —
 * this module never declares a second copy.
 *
 * `rubricVersion` is a hash over a CANONICAL serialization of prompt +
 * taxonomy (§12.3): keys are stably ordered and whitespace is normalized
 * before hashing, so an intentional edit forks the version and whitespace
 * churn does not. A narrowing of the taxonomy is a new rubric version,
 * never an in-place edit (§12.4).
 */
import { createHash } from "node:crypto";
import { CONFIDENCE_BANDS, VERDICT_CLASSES, VERDICT_NOTE_MAX_CHARS } from "./wire.ts";

/**
 * Per-class definitions, rendered into the system prompt. Order and keys
 * match `VERDICT_CLASSES` (checked by a test) so the list stays diffable
 * against the §12.4 table in docs/design/agent-analytics.md.
 */
export const CLASS_DEFINITIONS: Readonly<Record<(typeof VERDICT_CLASSES)[number], string>> = {
	clean:
		"No behavioral failure. The baseline class, so every denominator exists. " +
		"It is exclusive: a verdict that assigns clean assigns nothing else, and " +
		"it carries no evidence ranges — there is no range to point at for " +
		"'no behavioral failure'.",
	wrong_approach:
		"Coherent work aimed at a strategy the task does not support. The route " +
		"is wrong, not the target.",
	misread_requirements:
		"Solved a different problem than the issue states. Distinct from " +
		"wrong_approach: wrong target versus wrong route to the right target.",
	spin_loop:
		"Repeated near-identical actions without state change. The judge-grade " +
		"sibling of the heuristic stuckScore.",
	context_thrash:
		"Re-reads and re-derives the same information; the context fills with " +
		"redundant tool output.",
	env_fumble:
		"Fought the sandbox or tooling rather than the task — missing deps, " +
		"wrong commands, permission loops — while the infrastructure itself was " +
		"healthy.",
	tool_misuse:
		"Persistently malformed tool calls, wrong flags, or misread tool output. " +
		"Distinct from env_fumble: the tool worked, the agent misused it.",
	gate_flunk:
		"The work reached the quality gates, failed them, and the agent either " +
		"stopped or shipped anyway.",
	premature_success:
		"Declared done without verifying: pushed with failing or absent tests, " +
		"or an empty push with dirty paths.",
	scope_creep:
		"The task plus unrequested changes — drive-by refactors that bloat the " +
		"diff and endanger the merge.",
	scope_shortfall: "Stopped early with named requirements unaddressed.",
	destructive_recovery:
		"Recovered from a mistake by destroying work — hard resets, wholesale " +
		"rewrites — losing progress a cheaper correction would have kept.",
	hallucinated_state: "Acted on files, APIs, or repo facts that do not exist.",
	steering_rescued:
		"Succeeded only after human steering redirected it. A positive signal, " +
		"not a demerit.",
	steering_resistant: "Received steering and failed to incorporate it.",
};

/**
 * Render the judge system prompt for rubric v1. The prompt carries the
 * enforcement the pi session API cannot: there is no provider tool_choice
 * forcing at that layer, so the prompt makes `report_verdict` the mandatory
 * final action, and a judgment that ends in plain text is a failed judgment.
 */
export function renderJudgeSystemPrompt(): string {
	const taxonomy = VERDICT_CLASSES.map(
		(cls, i) => `${i + 1}. \`${cls}\` — ${CLASS_DEFINITIONS[cls]}`,
	).join("\n");
	return [
		"You are the warren judge: a bounded, read-only evaluator of one finished",
		"agent run. You hold no mutation capability of any kind. Your entire tool",
		"surface is: read the run, then emit exactly one verdict.",
		"",
		"## Inputs",
		"",
		"- `get_run_facts` returns the run's ground truth: outcome, failure",
		"  reason, cost, and PR state. Read it first.",
		"- `page_events` cursors the run's NormalizedEvent rows by sequence",
		"  number. Page through the transcript before judging; transcripts",
		"  routinely exceed one context window, so never judge from the first",
		"  page alone.",
		"",
		"## Ground truth reconciliation (mandatory)",
		"",
		"`get_run_facts` is warren's authoritative account of how the run",
		"ended. Reconcile your verdict against it before reporting:",
		"",
		"- Always page the transcript TAIL, not just the head. The `reap.*`",
		"  events at the end are the run's actual outcome: `reap.empty_push`",
		"  with dirty paths means the agent staged or left work uncommitted",
		"  and nothing landed.",
		"- `failureReason: dropped_commit` means the run ended with work that",
		"  never landed as a commit — that is `premature_success` territory,",
		"  with the reap tail as evidence. Assign `clean` instead only when",
		"  the tail shows the recorded reason is wrong, and say why in the",
		"  note.",
		"- Infrastructure failure reasons — `provider_error`, `oom_killed`,",
		"  `evicted`, `never_started`, `sandbox_failed`, `sandbox_run_lost`,",
		"  `sandbox_unreachable`, or a host-side `finalize_failed` /",
		"  `finalize_unposted` — CAN coexist with `clean`: judge the agent's",
		"  behavior, not the infrastructure.",
		"- A `clean` verdict on a run whose failureReason names agent",
		"  behavior contradicts the ground truth. Never report that",
		"  combination without having read the tail and explained the",
		"  contradiction in the note.",
		"",
		"## The rubric-v1 taxonomy (15 classes, multi-label)",
		"",
		"Assign every class the transcript supports. A run can be `spin_loop`",
		"and `env_fumble` at once. `clean` is exclusive: a verdict that assigns",
		"it assigns nothing else.",
		"",
		taxonomy,
		"",
		"## Evidence pointability (mandatory)",
		"",
		"A class must be evidence-pointable to event ranges, or it does not",
		"belong in the verdict. Every assigned class except `clean` carries at",
		"least one evidence range `{fromSeq, toSeq}` — inclusive run event",
		"sequence numbers you actually saw while paging. \"`spin_loop`, events",
		"340–612\" is auditable; a paragraph is not. `clean` carries no ranges.",
		"",
		"Confidence is a band, never a float: `low`, `medium`, or `high`. Use",
		"`high` only when the evidence ranges leave no reasonable doubt; use",
		"`low` when the transcript ran out before the behavior resolved.",
		"",
		`Each class may add one optional free-text note, capped at ${VERDICT_NOTE_MAX_CHARS}`,
		"characters, as a human-review hint. The ranges remain the evidence; a",
		"note never substitutes for them.",
		"",
		"## Final action (mandatory)",
		"",
		"Your final action MUST be a call to the `report_verdict` tool. Calling",
		"it ends the judgment. There is no provider-level tool forcing on this",
		"session, so the enforcement is this instruction: a judgment that ends",
		"in plain text — a summary, an apology, a refusal — is a failed",
		"judgment and counts against the retry budget. When you have enough",
		"evidence, stop paging and call `report_verdict`.",
	].join("\n");
}

/** Normalize whitespace so cosmetic churn does not fork the rubric version. */
export function normalizeWhitespace(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\t/g, "  ")
		.split("\n")
		.map((line) => line.replace(/\s+$/u, ""))
		.join("\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

/**
 * Stable-key JSON serialization: object keys sort lexicographically at every
 * depth, so semantically equal inputs serialize byte-identically regardless
 * of construction order.
 */
export function canonicalSerialize(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalSerialize(item)).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalSerialize(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The canonical rubric payload: the normalized system prompt plus the
 * normalized taxonomy (class + definition pairs in taxonomy order).
 */
export function canonicalRubricPayload(): string {
	return canonicalSerialize({
		prompt: normalizeWhitespace(renderJudgeSystemPrompt()),
		taxonomy: VERDICT_CLASSES.map((cls) => ({
			class: cls,
			definition: normalizeWhitespace(CLASS_DEFINITIONS[cls]),
		})),
		confidenceBands: [...CONFIDENCE_BANDS],
		noteMaxChars: VERDICT_NOTE_MAX_CHARS,
	});
}

/**
 * Compute the rubric version: `sha256:<hex>` over the canonical payload.
 * An intentional edit to the prompt or the taxonomy forks the version;
 * whitespace churn and key-order churn do not.
 */
export function computeRubricVersion(): string {
	const hex = createHash("sha256").update(canonicalRubricPayload(), "utf8").digest("hex");
	return `sha256:${hex}`;
}
