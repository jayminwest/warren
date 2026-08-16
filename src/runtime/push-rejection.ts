/**
 * Remote-policy push rejection parser (warren-b68d).
 *
 * A branch push that GitHub refuses on POLICY grounds — secret-scanning push
 * protection, a repository ruleset, a protected-branch rule — fails the same
 * way a non-fast-forward push does: non-zero exit, stderr, no branch. Reap saw
 * only that, so both collapsed into `finalize_failed` and the operator was left
 * grepping the raw event payload for the remediation URL GitHub had already
 * printed (run_m6br4vntg007, 2026-07-30, $7.23 of agent work discarded).
 *
 * The two cases want different operator moves. A non-fast-forward is warren's
 * problem: rebase and re-push. A policy rejection is the operator's: allow-list
 * the secret at the unblock URL, or change the content GitHub refused. Only the
 * second is parsed here, and the discriminator is the marker GitHub prints, not
 * the exit code.
 *
 * Both finalize implementations feed this: `k8s/finalize-collect.ts` from the
 * push's `stderr`/`stdout`, `local/finalize.ts` from the rejected `Error`'s
 * message (`ReapExec.run` carries stderr there). Keeping the parse in one pure
 * function is what stops the two from drifting.
 */

/**
 * What GitHub refused, and what an operator needs to act on it.
 *
 * Both lists can be empty: GitHub varies its output by rule kind, and a
 * ruleset violation that is not a secret carries no unblock URL at all. An
 * empty list means "GitHub printed none", never "the parse failed" — a failed
 * parse is `null` from {@link parsePushRejection}.
 */
export interface PushRejection {
	/**
	 * The `security/secret-scanning/unblock-secret/...` URLs GitHub returned,
	 * one per blocked secret, in the order printed. This is the remediation the
	 * issue asked to surface: it allow-lists that one secret so the same push
	 * succeeds on retry.
	 */
	readonly unblockUrls: readonly string[];
	/**
	 * The `path:line` locations GitHub listed under each blocked secret, in the
	 * order printed. Duplicates are dropped: the same fixture flagged by two
	 * rules prints twice and reads as two findings.
	 */
	readonly locations: readonly string[];
}

/**
 * Event kind a finalize implementation appends to `FinalizeResult.events` when
 * it parses a policy refusal. Reap replays every finalize event through its
 * real event surface, so declaring the kind here (rather than adding a field to
 * the `FinalizeResult` seam) is what carries the remediation to the operator
 * AND tells the domain which failure reason to record. Payload is a
 * {@link PushRejection}.
 */
export const PUSH_REJECTED_EVENT = "reap.push_rejected";

/**
 * Markers that mean "the remote applied a policy", each taken from output
 * GitHub actually prints:
 *
 *   - `GH013` heads a repository-rule violation, `GH006` a protected-branch
 *     update refusal.
 *   - `GITHUB PUSH PROTECTION` heads the secret-scanning block.
 *   - The two prose forms appear without their codes when the push is refused
 *     by a pre-receive hook rather than the ruleset engine.
 *
 * A non-fast-forward rejection prints none of these — it prints `[rejected]`
 * with `(non-fast-forward)` or `(fetch first)` — so it stays `finalize_failed`,
 * which is the existing and correct classification for it.
 */
const POLICY_MARKERS: readonly RegExp[] = [
	/\bGH006\b/,
	/\bGH013\b/,
	/GITHUB PUSH PROTECTION/i,
	/push declined due to repository rule violations/i,
	/protected branch (?:update failed|hook declined)/i,
];

/** GitHub's per-secret allow-list URL. */
const UNBLOCK_URL = /https?:\/\/\S*?\/security\/secret-scanning\/unblock-secret\/[^\s)\]]+/gi;

/** A `path:` entry under a `locations:` block, once the `remote:` prefix is off. */
const LOCATION_LINE = /^path:\s*(\S.*?)\s*$/i;

/**
 * Strip git's `remote: ` echo prefix and surrounding whitespace so the matchers
 * see the server's own text. Git indents continuation lines under the prefix,
 * which is why the trim happens after the strip and not before.
 */
function normalizeLines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*remote:\s?/i, "").trim())
		.filter((line) => line !== "");
}

/**
 * Trailing punctuation GitHub wraps a URL in when it ends a sentence. The URL
 * itself ends in a slash, which must survive.
 */
function trimUrl(url: string): string {
	return url.replace(/[.,;]+$/, "");
}

/** Keep first occurrence, drop repeats, preserve order. */
function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/**
 * Parse a failed push's output. Returns `null` when the remote refused for any
 * reason OTHER than policy, which includes the ordinary non-fast-forward and
 * every auth failure — the caller keeps its existing behavior for those.
 *
 * @param output - The push's combined stderr/stdout, or the rejected `Error`'s
 *   message. Empty input is not a rejection.
 */
export function parsePushRejection(output: string): PushRejection | null {
	if (output === "") return null;
	const lines = normalizeLines(output);
	if (lines.length === 0) return null;

	const body = lines.join("\n");
	if (!POLICY_MARKERS.some((marker) => marker.test(body))) return null;

	const unblockUrls = unique((body.match(UNBLOCK_URL) ?? []).map(trimUrl));
	const locations = unique(
		lines.flatMap((line) => {
			const match = LOCATION_LINE.exec(line);
			return match?.[1] === undefined ? [] : [match[1]];
		}),
	);

	return { unblockUrls, locations };
}
