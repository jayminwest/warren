/**
 * Test fixtures shaped like ClawSweeper's real comments on openclaw PR
 * 132081 (warren-b990). Shared by the classifier and tick tests.
 *
 * ClawSweeper posts one acknowledgement comment and one review comment,
 * then delivers every later verdict by EDITING the review comment in
 * place: the node id stays, `updated_at` and the body move. The verdict
 * body leads with a summary and roughly 8 KiB of score and verification
 * tables. The `## Findings` list sits mid-body. A collapsed review-history
 * log below it repeats earlier finding titles under its own heading.
 */

/** The acknowledgement placeholder ClawSweeper posts first. */
export const CLAWSWEEPER_ACK_BODY = [
	"<!-- clawsweeper-pr-ack:opened item=132081 -->",
	"ClawSweeper picked this up.",
	"",
	"Pull request received. I will update this pull request when review starts.",
].join("\n");

/** One table row of filler, repeated to push the findings past 8 KiB. */
const SCORE_ROW =
	"| **Proof confidence** | 3/6 | Needs stronger real behavior proof before merge: refresh " +
	"redacted terminal output through the repaired production path. |";

/**
 * A verdict body for one review revision. `findings` are finding lines
 * as ClawSweeper renders them, e.g. "- [P1] Title — `src/a.ts:1-2`".
 */
export function clawsweeperVerdictBody(revision: number, findings: readonly string[]): string {
	return [
		`Codex review: needs real behavior proof before merge. _(Revision ${revision})._`,
		"",
		"# ClawSweeper review",
		"",
		"## Review scores",
		"",
		"| Measure | Result | What it means |",
		"|---|---|---|",
		...Array.from({ length: 60 }, () => SCORE_ROW),
		"",
		"## Findings",
		"",
		...findings,
		"",
		"<details>",
		"<summary><strong>Agent review details</strong></summary>",
		"",
		"### History",
		"",
		"- [P1] An earlier revision's finding that a later review dropped — `src/old.ts:1`",
		"",
		"</details>",
		"",
		`<!-- clawsweeper-review item=132081 revision=${revision} -->`,
	].join("\n");
}
