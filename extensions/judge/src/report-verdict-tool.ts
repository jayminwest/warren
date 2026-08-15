/**
 * The `report_verdict` tool: schema, validation, and prompt guidelines.
 *
 * The parameters are a TypeBox schema derived from `wire.ts` — the enum
 * vocabularies, the note cap, and the range shape all come from the locked
 * artifact, never a second copy. Validation happens at the tool layer in
 * two passes: the TypeBox-compiled schema checks structure, then the
 * §12.3 cross-field rules (clean exclusivity, per-class evidence presence,
 * no duplicate classes, ordered ranges) run over the checked value.
 *
 * The pi session API surfaces no provider tool_choice forcing, so the
 * tool's `promptGuidelines` carries the enforcement: `report_verdict` is
 * the MANDATORY final action of every judgment.
 */
import { Type, type Static } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
	CONFIDENCE_BANDS,
	VERDICT_CLASSES,
	VERDICT_NOTE_MAX_CHARS,
	VerdictValidationError,
} from "./wire.ts";

const EvidenceRangeSchema = Type.Object(
	{
		fromSeq: Type.Integer({
			minimum: 0,
			description: "Inclusive first run event sequence number of the evidence range.",
		}),
		toSeq: Type.Integer({
			minimum: 0,
			description: "Inclusive last run event sequence number; must be >= fromSeq.",
		}),
	},
	{ additionalProperties: false },
);

const ClassAssignmentSchema = Type.Object(
	{
		class: Type.Union(
			VERDICT_CLASSES.map((cls) => Type.Literal(cls)),
			{ description: "One rubric-v1 taxonomy class (agent-analytics §12.4)." },
		),
		confidence: Type.Union(
			CONFIDENCE_BANDS.map((band) => Type.Literal(band)),
			{ description: "Confidence band — low, medium, or high. Never a float." },
		),
		evidence: Type.Array(EvidenceRangeSchema, {
			description:
				"Inclusive event sequence ranges the class points at. At least one for every " +
				"class except clean; exactly none for clean.",
		}),
		note: Type.Optional(
			Type.String({
				maxLength: VERDICT_NOTE_MAX_CHARS,
				description: `Optional human-review hint, capped at ${VERDICT_NOTE_MAX_CHARS} characters. Never a substitute for evidence ranges.`,
			}),
		),
	},
	{ additionalProperties: false },
);

/**
 * The `report_verdict` tool parameters, TypeBox-derived from `wire.ts`.
 * Provenance is absent by design: the judge loop attaches it (provider,
 * model, rubric version, judged-at, cost) after the model reports.
 */
export const REPORT_VERDICT_PARAMETERS = Type.Object(
	{
		runId: Type.String({ minLength: 1, description: "The id of the run being judged." }),
		assignments: Type.Array(ClassAssignmentSchema, {
			minItems: 1,
			description:
				"Multi-label taxonomy assignments. clean is exclusive: a verdict that " +
				"assigns it assigns nothing else.",
		}),
	},
	{ additionalProperties: false },
);

export type ReportVerdictArgs = Static<typeof REPORT_VERDICT_PARAMETERS>;

const compiled = TypeCompiler.Compile(REPORT_VERDICT_PARAMETERS);

function fail(reason: string): never {
	throw new VerdictValidationError(reason);
}

/**
 * Validate unknown tool arguments into {@link ReportVerdictArgs}. Pass one is
 * the compiled TypeBox schema; pass two enforces the §12.3 cross-field rules
 * the schema cannot express. Throws {@link VerdictValidationError}.
 */
export function validateReportVerdictArgs(value: unknown): ReportVerdictArgs {
	if (!compiled.Check(value)) {
		const first = compiled.Errors(value).First();
		fail(
			first === undefined
				? "report_verdict: arguments failed the tool schema"
				: `report_verdict: ${first.path || "/"} ${first.message}`,
		);
	}
	const args = value as ReportVerdictArgs;
	const seen = new Set<string>();
	for (const [i, assignment] of args.assignments.entries()) {
		const where = `assignments[${i}]`;
		if (seen.has(assignment.class)) {
			fail(`${where}: class "${assignment.class}" assigned more than once`);
		}
		seen.add(assignment.class);
		if (assignment.class !== "clean" && assignment.evidence.length === 0) {
			fail(`${where}: class "${assignment.class}" requires at least one evidence range`);
		}
		if (assignment.class === "clean" && assignment.evidence.length > 0) {
			fail(`${where}: "clean" carries no evidence ranges`);
		}
		for (const [j, range] of assignment.evidence.entries()) {
			if (range.toSeq < range.fromSeq) {
				fail(`${where}.evidence[${j}]: toSeq must be >= fromSeq`);
			}
		}
	}
	if (seen.has("clean") && args.assignments.length > 1) {
		fail('assignments: "clean" is exclusive — a verdict that assigns it assigns nothing else');
	}
	return args;
}

/**
 * The prompt-guidelines snippet the pi SDK surfaces alongside the tool. This
 * is the enforcement layer: the session API has no provider tool_choice
 * forcing, so the prompt makes `report_verdict` the mandatory final action.
 */
export const REPORT_VERDICT_PROMPT_GUIDELINES = [
	"report_verdict is the MANDATORY final action of every judgment. When you",
	"have paged enough of the transcript to assign classes with evidence, call",
	"report_verdict exactly once and stop. Do not end the judgment with a",
	"plain-text summary: there is no provider-level tool forcing on this",
	"session, so an un-called verdict is a failed judgment and consumes the",
	"retry budget. Every class except clean must point at evidence ranges",
	"{fromSeq, toSeq} you actually saw; confidence is a band (low, medium,",
	"high), never a number.",
].join("\n");

/**
 * The tool descriptor the judge loop (plan pl-17ca step 5) registers with
 * the pi SDK's customTools. `execute` returning `terminate: true` is wired
 * in that step; this module owns the schema and the prompt-facing text.
 */
export const REPORT_VERDICT_TOOL = {
	name: "report_verdict",
	description:
		"Emit the rubric-v1 verdict for the judged run and end the judgment. " +
		"Multi-label assignments over the 15-class taxonomy, banded confidence, " +
		"evidence ranges per non-clean class, provenance attached by the loop.",
	parameters: REPORT_VERDICT_PARAMETERS,
	promptGuidelines: REPORT_VERDICT_PROMPT_GUIDELINES,
} as const;
