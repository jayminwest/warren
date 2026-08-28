/**
 * Profile-declared bot grammar for review-feedback classification
 * (plan pl-096b step warren-2ec3).
 *
 * Recognition rules are *data*, never code: the repository profile declares
 * which upstream accounts are review bots, the durable-comment marker that
 * prefixes a structured finding list, the line grammar findings follow, and
 * the exact comment commands that request a re-review. Everything here is
 * operator-supplied profile content — validated fail-closed, bounded in
 * size, and compiled once — so a comment can never add recognition rules to
 * itself. Upstream comment text is matched against this grammar but is
 * never treated as configuration.
 */

import { ValidationError } from "../errors.ts";
import { isValidOwner } from "../github-grammar.ts";
import {
	asObject,
	rejectUnknownKeys,
	requireString,
	requireStringArray,
} from "../validate-utils.ts";

/** Hard bounds — a grammar is small, deliberate configuration. */
const MAX_BOT_LOGINS = 50;
const MAX_RE_REVIEW_COMMANDS = 20;
const MAX_MARKER_LENGTH = 128;
const MAX_PATTERN_LENGTH = 256;

/** Input ceiling before any profile pattern runs against comment text. */
export const MAX_CLASSIFIED_BODY_LENGTH = 8192;

/**
 * The profile-declared recognition rules. `findingLinePattern` is a regex
 * *source* matched line-by-line; its named groups are the only fields ever
 * extracted: `title` (required for a finding), plus optional `file`, `line`,
 * and `priority`. No other capture is read.
 */
export interface ReviewBotGrammar {
	/** Upstream logins whose comments are review-bot output, not human review. */
	readonly knownBotLogins: readonly string[];
	/** Comment-body prefix marking a structured finding list. */
	readonly findingMarker: string;
	/** Line-by-line regex source for one finding (named groups above). */
	readonly findingLinePattern: string;
	/** Exact comment bodies that request a re-review. */
	readonly reReviewCommands: readonly string[];
}

const GRAMMAR_FIELDS = [
	"knownBotLogins",
	"findingMarker",
	"findingLinePattern",
	"reReviewCommands",
];

/** The named groups the classifier knows how to extract. */
const FINDING_GROUPS = ["title", "file", "line", "priority"] as const;

/**
 * Literal suffix GitHub appends to an App's author login: an App named
 * `clawsweeper` comments as `clawsweeper[bot]`. The classifier compares
 * whatever the API reports, so the grammar must be able to state it.
 */
const APP_BOT_SUFFIX = "[bot]";

/**
 * A bot login is a plain GitHub login, or an App login with the literal
 * `[bot]` suffix. In both cases the account name validates with the shared
 * login grammar; comparison stays exact-match downstream (warren-442e).
 */
function isValidBotLogin(login: string): boolean {
	if (login.endsWith(APP_BOT_SUFFIX)) {
		return isValidOwner(login.slice(0, -APP_BOT_SUFFIX.length));
	}
	return isValidOwner(login);
}

/**
 * Validate and normalize a bot grammar. Throws `ValidationError` on any
 * violation: unknown keys, oversized values, invalid logins, or a finding
 * pattern that fails to compile or exposes a capture group outside the
 * known extraction set (fail-closed — an unknown group could smuggle text
 * past the structured-field discipline).
 */
export function validateBotGrammar(input: unknown): ReviewBotGrammar {
	const root = asObject(input, "bot grammar");
	rejectUnknownKeys(root, GRAMMAR_FIELDS, "bot grammar");

	const knownBotLogins = requireStringArray(root, "knownBotLogins", "bot grammar", {
		maxItems: MAX_BOT_LOGINS,
		maxLen: MAX_MARKER_LENGTH,
	});
	for (const login of knownBotLogins) {
		if (!isValidBotLogin(login)) {
			throw new ValidationError(
				`invalid bot login "${login}" at 'bot grammar.knownBotLogins' — expected a valid GitHub login or App bot login '<owner>[bot]'`,
			);
		}
	}

	const findingMarker = requireString(root, "findingMarker", "bot grammar", {
		min: 1,
		max: MAX_MARKER_LENGTH,
	});
	const findingLinePattern = requireString(root, "findingLinePattern", "bot grammar", {
		min: 1,
		max: MAX_PATTERN_LENGTH,
	});
	compileFindingPattern(findingLinePattern);
	const reReviewCommands = requireStringArray(root, "reReviewCommands", "bot grammar", {
		maxItems: MAX_RE_REVIEW_COMMANDS,
		maxLen: MAX_MARKER_LENGTH,
	});
	return { knownBotLogins, findingMarker, findingLinePattern, reReviewCommands };
}

/**
 * Compile the profile regex source and pin its capture surface. The pattern
 * must compile, expose `title`, and capture nothing outside
 * `FINDING_GROUPS` — anything else is rejected at validation time, so
 * runtime extraction can never widen.
 */
function compileFindingPattern(source: string): RegExp {
	let compiled: RegExp;
	try {
		compiled = new RegExp(source);
	} catch (error) {
		throw new ValidationError(
			`invalid regex at 'bot grammar.findingLinePattern' — ${error instanceof Error ? error.message : "does not compile"}`,
		);
	}
	if (compiled.source.includes("(?<")) {
		// Extract declared group names from the source text.
		const declared = [...compiled.source.matchAll(/\(\?<(?![=!])([A-Za-z_][A-Za-z0-9_]*)>/g)]
			.map((m) => m[1])
			.filter((name): name is string => typeof name === "string");
		for (const name of declared) {
			if (!(FINDING_GROUPS as readonly string[]).includes(name)) {
				throw new ValidationError(
					`unknown capture group "?<${name}>" at 'bot grammar.findingLinePattern' — allowed groups: ${FINDING_GROUPS.join(", ")}`,
				);
			}
		}
		if (!declared.includes("title")) {
			throw new ValidationError(
				`missing required capture group "?<title>" at 'bot grammar.findingLinePattern'`,
			);
		}
	} else {
		throw new ValidationError(
			`missing required capture group "?<title>" at 'bot grammar.findingLinePattern' — the pattern must be a named-group regex`,
		);
	}
	return compiled;
}

/** Compile once per use; validation already pinned the capture surface. */
export function compileBotGrammar(grammar: ReviewBotGrammar): RegExp {
	return new RegExp(grammar.findingLinePattern);
}
