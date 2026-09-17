/**
 * Git reads for the auto-merge arming policy (warren-970a, plan pl-92a3
 * step 5): the changed-path list and the base-ref `pr.autoMerge` config that
 * `decideAutoMerge` (auto-merge-policy.ts) consumes. All I/O for the arm
 * decision lives here, behind the `ReapExec` seam reap already uses — the
 * same spawn shape `outcome-facts.ts` reads its `git diff --numstat`
 * through — so no code path spawns git a second way.
 *
 * Two fail-closed rules shape this module (docs/design/forge-auto-merge.md
 * §4.4 / §3.1):
 *
 *   - The changed-path list comes from a three-dot diff (`base...head`,
 *     merge-base semantics) run in the project clone reap already holds,
 *     never from the forge files API — the warren-7b2f bypass was one wrong
 *     API field name away from a silent permit, and a git read cannot key
 *     the wrong field. ANY git failure returns the unreadable marker, which
 *     the policy refuses to arm on.
 *   - The `pr.autoMerge` policy resolves from the PR's BASE ref
 *     (`git show <base>:.warren/config.yaml`), NEVER from the run-branch
 *     working tree. The agent authors the run branch — a policy the agent
 *     can edit in the same pull request is not a policy. A config file
 *     absent, unreadable, or invalid at the base ref reads as `undefined`
 *     (`off`), so arming never engages without a positive, valid opt-in on
 *     the ref this PR actually targets.
 *
 * The wiring into the reap PR-open step is warren-14d6; nothing here calls
 * the policy or the forge.
 */

import { load } from "js-yaml";
import { warrenConfigRelativePath } from "../../warren-config/config.ts";
import { type AutoMergeConfig, PrConfigSchema } from "../../warren-config/pr-config.ts";
import type { ChangedPaths } from "./auto-merge-policy.ts";
import type { ReapExec } from "./types.ts";

/** Same per-call budget `outcome-facts.ts` gives its git reads. */
const GIT_TIMEOUT_MS = 10_000;

/* ----------------------------------------------------------------------- */
/* Changed paths: the three-dot diff                                         */
/* ----------------------------------------------------------------------- */

/**
 * Compute the changed-path list for the arm decision with
 * `git diff --name-only --no-renames -z base...head` in `cwd` (the project
 * clone reap already holds; under K8s the caller fetches the run branch
 * into a temp ref first, the `outcome-facts.ts` trick). Three-dot keeps
 * merge-base semantics — the list shows what the head changed since the
 * branches diverged, base-side drift excluded, exactly the changes this
 * pull request carries.
 *
 * `--no-renames` is the fail-closed choice: with rename detection a pure
 * `git mv` shows only the destination path, so a rename that moves a file
 * OUT of a protected path would silently miss the protected side. With it,
 * a rename lists both the old and the new path. `-z` gives NUL-separated
 * unquoted paths, so a path with quotes or unicode matches literally.
 *
 * Any git failure (bad ref, unborn repo, timeout) resolves to the
 * `unreadable` marker — never a throw, never a guessed list.
 */
export async function computeAutoMergeChangedPaths(
	exec: ReapExec,
	cwd: string,
	baseRef: string,
	headRef: string,
): Promise<ChangedPaths> {
	try {
		const out = await exec.run(
			"git",
			["diff", "--name-only", "--no-renames", "-z", `${baseRef}...${headRef}`],
			{ cwd, timeoutMs: GIT_TIMEOUT_MS },
		);
		return { kind: "changed", paths: out.stdout.split("\0").filter((path) => path !== "") };
	} catch {
		return { kind: "unreadable" };
	}
}

/* ----------------------------------------------------------------------- */
/* The policy source: the BASE ref, never the run branch                     */
/* ----------------------------------------------------------------------- */

/**
 * Load the `pr.autoMerge` block from `.warren/config.yaml` AT THE BASE REF —
 * `git show <base>:.warren/config.yaml` in the project clone — never from
 * the run-branch working tree (the agent authors the run branch; see the
 * module header). For a normal run the base ref is the project default
 * branch; for a chained plan-run child it is the previous child's branch.
 * The companion `config_changed` rule (policy module) closes the bypass a
 * config edit on the run branch would otherwise leave open.
 *
 * `undefined` (auto-merge off) when the file is absent at the base ref or
 * the read fails — indistinguishable on purpose: without a positive,
 * readable opt-in on the base this pull request targets, arming never
 * engages. The legacy `defaults.json` is deliberately NOT consulted — the
 * design record names `.warren/config.yaml` at the base ref as the source.
 */
export async function readBaseAutoMergeConfig(
	exec: ReapExec,
	cwd: string,
	baseRef: string,
): Promise<AutoMergeConfig | undefined> {
	let raw: string;
	try {
		const out = await exec.run(
			"git",
			["show", `${baseRef}:${warrenConfigRelativePath("config")}`],
			{ cwd, timeoutMs: GIT_TIMEOUT_MS },
		);
		raw = out.stdout;
	} catch {
		return undefined;
	}
	return parseBaseAutoMergeConfig(raw);
}

/**
 * Parse raw `.warren/config.yaml` content (as read from the base ref) into
 * the `pr.autoMerge` block, reusing `PrConfigSchema` — the same schema the
 * on-disk loader validates the block against, so there is exactly one
 * definition of the shape (AGENTS.md "Single source of truth"). Pure, so
 * the table tests drive it without git.
 *
 * `undefined` whenever the block is absent (`pr` key missing, `autoMerge`
 * key missing) or the content does not validate (malformed YAML, a
 * non-object document, a `pr.autoMerge: true` shorthand, unknown keys).
 * Every miss reads as off: an operator typo must never widen arming, and
 * the design record's vocabulary has no separate invalid reason — the skip
 * is the `off` divergence event either way.
 */
export function parseBaseAutoMergeConfig(raw: string): AutoMergeConfig | undefined {
	// Comment-only or empty content parses to "absent" (the same
	// warren-381c rule the on-disk loader applies, so a bare `# comment`
	// config file at the base ref means off, not a parse miss).
	const trimmed = raw.replace(/^\s*#.*$/gm, "").trim();
	if (trimmed === "") return undefined;
	let document: unknown;
	try {
		document = load(raw);
	} catch {
		return undefined;
	}
	if (typeof document !== "object" || document === null) return undefined;
	const parsed = PrConfigSchema.safeParse((document as Record<string, unknown>).pr);
	if (!parsed.success) return undefined;
	return parsed.data.autoMerge;
}
