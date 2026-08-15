/**
 * The judge verdict wire shape — rubric v1, locked 2026-08-15.
 *
 * Encodes the verdict contract from docs/design/agent-analytics.md §12.3 and
 * the behavioral failure taxonomy from §12.4. A verdict is an interpretation,
 * never a fact, so provenance is mandatory on every verdict. Re-judging under
 * a new rubric version appends a verdict; it never overwrites one.
 *
 * Standalone-package posture (docs/design/extensions.md): nothing here is
 * imported from warren core. The taxonomy is behavioral and orthogonal to
 * core's `RUN_FAILURE_REASONS` (infrastructure), so this package declares its
 * own closed vocabulary.
 */

/**
 * The fifteen rubric-v1 taxonomy classes (agent-analytics §12.4, owner cut
 * 2026-08-15). Multi-label by design; `clean` is exclusive. Order matches the
 * design record's table so the list is diffable against it.
 */
export const VERDICT_CLASSES = [
	"clean",
	"wrong_approach",
	"misread_requirements",
	"spin_loop",
	"context_thrash",
	"env_fumble",
	"tool_misuse",
	"gate_flunk",
	"premature_success",
	"scope_creep",
	"scope_shortfall",
	"destructive_recovery",
	"hallucinated_state",
	"steering_rescued",
	"steering_resistant",
] as const;
export type VerdictClass = (typeof VERDICT_CLASSES)[number];

/**
 * Confidence is a band, never a float (§12.3). A cheap judge does not own
 * the calibration a 0–1 float pretends to; the Goodhart door (§12.5) only
 * needs a high-confidence threshold, and the strong-model re-judge measures
 * band agreement directly.
 */
export const CONFIDENCE_BANDS = ["low", "medium", "high"] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/** Maximum length of a class assignment's optional free-text note (§12.3). */
export const VERDICT_NOTE_MAX_CHARS = 200;

/**
 * An evidence pointer: an inclusive range of run event sequence numbers.
 * "`spin_loop`, events 340–612" is auditable; a paragraph is not (§12.3).
 */
export interface EvidenceRange {
	readonly fromSeq: number;
	readonly toSeq: number;
}

/** One assigned taxonomy class with its confidence, evidence, and note. */
export interface ClassAssignment {
	readonly class: VerdictClass;
	readonly confidence: ConfidenceBand;
	/**
	 * Evidence ranges over the run's event sequence. Every class except
	 * `clean` carries at least one. `clean` carries none — there is no range
	 * to point at for "no behavioral failure".
	 */
	readonly evidence: readonly EvidenceRange[];
	/** Optional human-review hint, capped at {@link VERDICT_NOTE_MAX_CHARS}. */
	readonly note?: string;
}

/**
 * Provenance block (§12.3). Mandatory because a verdict is an interpretation:
 * which judge, under which rubric, when, and at what cost. `rubricVersion`
 * is a hash of prompt + taxonomy, so a query can refuse to mix rubric
 * versions on a trend line.
 */
export interface VerdictProvenance {
	/** Judge provider id (e.g. "anthropic"); never hardcoded to one vendor. */
	readonly provider: string;
	/** Judge model id (e.g. "claude-haiku-4-5"). */
	readonly model: string;
	/** Hash of prompt + taxonomy identifying the rubric version. */
	readonly rubricVersion: string;
	/** ISO 8601 timestamp of when the judgment was produced. */
	readonly judgedAt: string;
	/** USD cost of producing this judgment. */
	readonly costUsd: number;
	/**
	 * Events pages the judge read (across retries). Absent on judgments
	 * produced by rubric versions predating the page-cap mechanics.
	 */
	readonly pagesRead?: number;
	/**
	 * True when the judgment hit the hard events-page cap: the transcript
	 * tail was truncated and the verdict was judged from partial evidence.
	 * Distinguishes a capped judgment from a full one (§12.2).
	 */
	readonly pageCapHit?: boolean;
}

/** A rubric-v1 verdict over one run's transcript. */
export interface JudgeVerdict {
	readonly runId: string;
	readonly assignments: readonly ClassAssignment[];
	readonly provenance: VerdictProvenance;
}

/** Raised when a verdict fails the §12.3 contract at the parse boundary. */
export class VerdictValidationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "VerdictValidationError";
	}
}

function fail(reason: string): never {
	throw new VerdictValidationError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerdictClass(value: unknown): value is VerdictClass {
	return typeof value === "string" && (VERDICT_CLASSES as readonly string[]).includes(value);
}

function isConfidenceBand(value: unknown): value is ConfidenceBand {
	return typeof value === "string" && (CONFIDENCE_BANDS as readonly string[]).includes(value);
}

function parseEvidenceRange(value: unknown, where: string): EvidenceRange {
	if (!isRecord(value)) fail(`${where}: evidence range must be an object`);
	const { fromSeq, toSeq } = value;
	if (
		typeof fromSeq !== "number" ||
		!Number.isInteger(fromSeq) ||
		fromSeq < 0 ||
		typeof toSeq !== "number" ||
		!Number.isInteger(toSeq) ||
		toSeq < fromSeq
	) {
		fail(`${where}: evidence range must have integer fromSeq/toSeq with 0 <= fromSeq <= toSeq`);
	}
	return { fromSeq, toSeq };
}

function parseAssignment(value: unknown, where: string): ClassAssignment {
	if (!isRecord(value)) fail(`${where}: assignment must be an object`);
	const cls = value.class;
	if (!isVerdictClass(cls)) fail(`${where}: unknown class ${JSON.stringify(cls)}`);
	if (!isConfidenceBand(value.confidence)) {
		fail(`${where}: confidence must be one of ${CONFIDENCE_BANDS.join("/")} (a band, not a float)`);
	}
	if (value.evidence !== undefined && !Array.isArray(value.evidence)) {
		fail(`${where}: evidence must be an array of {fromSeq,toSeq} ranges`);
	}
	const evidence = (value.evidence ?? []).map((range, i) =>
		parseEvidenceRange(range, `${where}.evidence[${i}]`),
	);
	if (cls !== "clean" && evidence.length === 0) {
		fail(`${where}: class "${cls}" requires at least one evidence range`);
	}
	if (cls === "clean" && evidence.length > 0) {
		fail(`${where}: "clean" carries no evidence ranges`);
	}
	let note: string | undefined;
	if (value.note !== undefined) {
		if (typeof value.note !== "string") fail(`${where}: note must be a string`);
		if (value.note.length > VERDICT_NOTE_MAX_CHARS) {
			fail(`${where}: note exceeds the ${VERDICT_NOTE_MAX_CHARS}-character cap`);
		}
		note = value.note;
	}
	return note === undefined
		? { class: cls, confidence: value.confidence, evidence }
		: { class: cls, confidence: value.confidence, evidence, note };
}

function parseProvenance(value: unknown): VerdictProvenance {
	if (!isRecord(value)) fail("provenance: must be an object and is mandatory");
	const { provider, model, rubricVersion, judgedAt, costUsd } = value;
	if (typeof provider !== "string" || provider.length === 0) {
		fail("provenance.provider: must be a non-empty string");
	}
	if (typeof model !== "string" || model.length === 0) {
		fail("provenance.model: must be a non-empty string");
	}
	if (typeof rubricVersion !== "string" || rubricVersion.length === 0) {
		fail("provenance.rubricVersion: must be a non-empty hash of prompt + taxonomy");
	}
	if (typeof judgedAt !== "string" || Number.isNaN(Date.parse(judgedAt))) {
		fail("provenance.judgedAt: must be a parseable ISO 8601 timestamp");
	}
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
		fail("provenance.costUsd: must be a finite non-negative number");
	}
	const { pagesRead, pageCapHit } = value;
	if (
		pagesRead !== undefined &&
		(typeof pagesRead !== "number" || !Number.isInteger(pagesRead) || pagesRead < 0)
	) {
		fail("provenance.pagesRead: must be a non-negative integer when present");
	}
	if (pageCapHit !== undefined && typeof pageCapHit !== "boolean") {
		fail("provenance.pageCapHit: must be a boolean when present");
	}
	return {
		provider: provider as string,
		model: model as string,
		rubricVersion: rubricVersion as string,
		judgedAt: judgedAt as string,
		costUsd: costUsd as number,
		...(pagesRead !== undefined ? { pagesRead: pagesRead as number } : {}),
		...(pageCapHit !== undefined ? { pageCapHit: pageCapHit as boolean } : {}),
	};
}

/**
 * Parse and validate an unknown value into a rubric-v1 {@link JudgeVerdict}.
 * Enforces the §12.3 invariants: multi-label assignments over the closed
 * 15-class taxonomy, `clean` exclusivity, at least one evidence range per
 * non-clean class, the 200-character note cap, and a mandatory provenance
 * block. Throws {@link VerdictValidationError} on any violation.
 */
export function parseVerdict(value: unknown): JudgeVerdict {
	if (!isRecord(value)) fail("verdict: must be an object");
	if (typeof value.runId !== "string" || value.runId.length === 0) {
		fail("runId: must be a non-empty string");
	}
	if (!Array.isArray(value.assignments) || value.assignments.length === 0) {
		fail("assignments: must be a non-empty array");
	}
	const assignments = value.assignments.map((a, i) => parseAssignment(a, `assignments[${i}]`));
	const seen = new Set<string>();
	for (const a of assignments) {
		if (seen.has(a.class)) fail(`assignments: class "${a.class}" assigned more than once`);
		seen.add(a.class);
	}
	if (seen.has("clean") && assignments.length > 1) {
		fail('assignments: "clean" is exclusive — a verdict that assigns it assigns nothing else');
	}
	return {
		runId: value.runId as string,
		assignments,
		provenance: parseProvenance(value.provenance),
	};
}

/**
 * Alias for {@link parseVerdict} at call sites that already hold a typed
 * value and want the contract re-checked (e.g. after in-memory construction).
 */
export function validateVerdict(value: unknown): JudgeVerdict {
	return parseVerdict(value);
}
