# UI design review rubric

**Kind:** contract
**Design state:** approved
**Delivery:** mixed
**Arrived:** 2026-10-08

This record is the fixed rubric for the independent UI evaluator in plan
`pl-10db` (seed `warren-7d12`). It names each criterion, the evidence
that proves it, the severity of a miss, and the pass rule. It also fixes
the verdict JSON that the evaluator writes and that the design-review
workflow reads.

The evaluator is the skill in
`.claude/skills/ui-design-review/SKILL.md`. The parser and pass rule live
once, in `scripts/design-review/verdict.ts`. If this record and that
module disagree, the module wins and this record is the bug.

## Scope status

| Scope | Delivery | Evidence |
|---|---|---|
| Rubric, verdict schema, and validator | `shipped` | `warren-7d12`: this record, `scripts/design-review/verdict.ts` |
| Evaluator skill | `shipped` | `warren-7d12`: `.claude/skills/ui-design-review/SKILL.md` |
| Workflow and `design-review` status check | `unscheduled` | `warren-a694` in plan `pl-10db` |
| Auto-merge requires the check for UI PRs | `unscheduled` | `warren-dbef` in plan `pl-10db` |

---

## 1. Why a separate evaluator

An agent that grades its own UI praises mediocre work. A separate agent
with a fresh context and a fixed rubric holds the line. So the evaluator
never writes UI code, and it never sees the author's reasoning. It sees
the rendered screenshots and the diff, and it answers to this rubric.

The evaluator does not replace the mechanical gates. It covers what they
cannot measure: hierarchy, rhythm, consistency with the primitives, copy,
states the fixture does not render, phone layout, and theme parity.

## 2. What the mechanical gates already hold

The evaluator does not re-judge a mechanical gate. It reads the gate's
outcome and spends its attention on the gaps.

| Gate | Holds | Leaves to this rubric |
|---|---|---|
| `check:ui-visual` smoke (`scripts/ui-visual/smoke-checks.ts`) | Console errors, document overflow, empty root, `undefined`/`NaN` text | Clipped content inside a card, cramped rows, unreadable phone layouts |
| Tailwind arbitrary-value ratchet (`scripts/check-tailwind-arbitrary.ts`) | The per-file count of `prefix-[value]` literals | Whether a size or gap fits the scale, even under budget |
| GritQL bans (`.biome/plugins/`) | Raw `<button>`, `<input>`, `<select>`, `<textarea>`, and inline `style` | A hand-built `div` that copies a primitive's look |
| Biome `useSortedClasses` | Class order | Nothing visual |

## 3. Inputs

The evaluator reads three inputs.

1. **The screenshot artifact.** The `ui-visual` workflow uploads
   `scripts/ui-visual/out/` as `ui-screenshots-<head sha>`. The artifact
   root holds `screenshots/<page>.<viewport>.<theme>.png` and
   `ci-meta.json`. The page ids come from `PAGES` in
   `scripts/ui-visual/pages.ts`. The viewports are `desktop` (1440x900)
   and `phone` (393x852). The themes are `light` and `dark`.
2. **The PR diff** against its base.
3. **The pages in scope.** The caller passes a list of page ids, or all
   pages. A change to a shared component or to the console shell puts
   every page in scope.

The fixture boot seeds populated data. Most empty, loading, and error
branches therefore do not appear in any screenshot. The evaluator proves
those states from the diff (see `state-coverage`).

The approved design is the Direction C export in
[`docs/ui-revamp/README.md`](../ui-revamp/README.md), with the per-screen
exports under `docs/ui-revamp/screens/`. The token source is
`src/ui/src/tokens.css`. The responsive targets are in the "Responsive
contract" section of [`src/ui/README.md`](../../src/ui/README.md).

## 4. Severity

Each finding carries one severity.

- **blocker**: an operator cannot see, read, or reach information or an
  action in at least one case. Missing or stale evidence is a blocker.
- **major**: the page works, but it visibly breaks the approved design or
  the pattern of its sibling pages. An operator notices it.
- **minor**: polish. A reviewer notices it and an operator probably does
  not.

Each finding also carries an origin. `diff` means this PR introduced or
changed the defect. `pre-existing` means the defect is also on `main`.
Only `diff` findings count toward the verdict. The evaluator still
reports `pre-existing` findings so that someone can file them.

## 5. Criteria

Each criterion has a stable id. A finding names exactly one id. If a
defect fits two criteria, use the more specific one.

### `evidence-complete`

**Checks.** Every page in scope has all four screenshots: desktop and
phone, in light and dark. The `headSha` in `ci-meta.json` is the PR head
that the evaluator reviews.

**Evidence.** The artifact file list and `ci-meta.json`.

**Severity.** A missing case is a blocker for that page. A stale artifact
is a blocker for every page. The validator rejects a verdict that skips a
case and has no `evidence-complete` finding for it.

### `smoke-clean`

**Checks.** The `ui-visual` job finished with `outcome: "success"`. That
outcome covers console errors, horizontal overflow, an empty root, and
broken text.

**Evidence.** `ci-meta.json`.

**Severity.** Any other outcome is a blocker. The workflow normally runs
only after a green `ui-visual` job, so this finding is rare.

### `hierarchy`

**Checks.** Each page has one page title at the Direction C title size
(20px/24px, semibold, -0.025em tracking). Section labels look the same
on the page and on sibling pages (10px, semibold, uppercase, 0.08em
tracking). Each view has at most one primary action, and it reads as the
primary action.

**Evidence.** The desktop and phone screenshots of the page, compared
with one sibling page at the same viewport.

**Severity.** A missing or second page title is major. A primary action
that does not stand out is major. A section label that differs from its
siblings is minor.

### `type-scale`

**Checks.** Rendered text uses the sizes in the Typography section of
`docs/ui-revamp/README.md`. Those sizes are 20/24 for page titles, 12/16
for base UI text, 10 for section labels, and 10 to 11 for mono metadata.
Use a size outside that list only where the matching screen export
in `docs/ui-revamp/screens/` uses it for the same role, for
example a large stat figure. If `tokens.css` defines named type tokens,
the diff must use the names.

**Evidence.** Diff hunks that add `text-*` or `leading-*` classes, and
the screenshot where the text renders.

**Severity.** A new size outside the list is major. A size that is in the
list but wrong for its role is minor. For example, body text at the
label size.

### `spacing-rhythm`

**Checks.** Layout spacing uses steps of Tailwind's 4px spacing scale.
Layout spacing means page gutters, gaps between sections and cards, and
card padding. Half steps are fine. The page gutter is 14px on phone
and 24px from `md` up (`px-3.5 md:px-6` today). Sibling sections on one
page share one gap. Dense rows inside a table or an event line are out
of scope: the Direction C exports use 2px to 10px gaps there.

**Evidence.** The screenshot, compared with an unchanged sibling page at
the same viewport. Diff hunks that add spacing classes.

**Severity.** A gutter that differs from sibling pages is major. Uneven
gaps between sibling sections are minor.

### `primitive-consistency`

**Checks.** Controls, tables, badges, alerts, dialogs, and empty states
come from `src/ui/src/components/ui/` and look like the same primitive on
other pages. The GritQL ban catches a raw `<button>`. It does not catch a
`div` styled to look like a badge, or a table that copies `Table` by hand.

**Evidence.** Diff hunks that build a control, and the screenshot where
it renders next to existing primitives.

**Severity.** A hand-built copy of an existing primitive is major. A
primitive with a changed height, radius, or border that no longer matches
its siblings is minor.

### `state-coverage`

**Checks.** Each data surface that the diff adds or changes has an empty
state, a loading state, and an error state. Each state renders at both
viewports. A state inside a `hidden md:block` or `hidden sm:block`
wrapper with no phone twin does not render on phone.

**Evidence.** The diff: the branches on loading, error, and empty data,
and the wrappers around them. The fixture shows only the populated state,
so the screenshots cannot prove this criterion.

**Severity.** A state that leaves the phone view blank, with no message,
is a blocker. A missing error or empty state is major. A missing loading
state on a fast local read is minor.

### `operator-copy`

**Checks.** Captions, labels, and empty-state and error messages tell the
operator what they see or what they can do. They contain no
implementation notes: no seed ids, component names, API paths, phase
numbers, or "wired later" text. They contain no placeholder text. The
tone is plain and in sentence case, with no exclamation marks and no
marketing words.

**Evidence.** The text in the screenshots and the string literals in the
diff.

**Severity.** A visible implementation note or placeholder is major. Tone
or casing that differs from sibling pages is minor.

### `orphaned-controls`

**Checks.** Each control has a visible label or a clear icon, sits next
to the thing it acts on, and does something in the state shown. No
control wraps alone onto a row away from its group. A disabled control
shows why it is disabled. No separator or divider has nothing on one
side of it.

**Evidence.** The phone screenshots first, then desktop.

**Severity.** A control with no visible purpose or target is major. A
control that wraps badly but stays clear is minor.

### `phone-layout`

**Checks.** At 393px the page reads as designed, not as a squeezed
desktop. Rails stack. Wide tables become row cards or scroll inside their
card. Form controls keep 44px touch targets (`responsiveFormControl` in
`src/ui/src/components/ui/responsive.ts`). Truncated identifiers stay
reachable, for example through a link or a detail view. Text does not
clip inside its container.

**Evidence.** The phone screenshots, with the desktop screenshot of the
same page for the content that must be present.

**Severity.** Data or an action that the operator cannot read or reach on
phone is a blocker. A cramped or uneven layout that still works is major
when sibling pages do better, and minor otherwise.

### `theme-parity`

**Checks.** The light and dark screenshots show the same structure, and
every element is legible in both. Colors come from the tokens in
`src/ui/src/tokens.css`, so an element that vanishes in one theme
usually has a hard-coded color.

**Evidence.** The light and dark screenshots of the same page at the same
viewport, side by side.

**Severity.** Content that is invisible or illegible in one theme is a
blocker. Clearly weaker contrast in one theme, or a hard-coded color in
the diff, is major. A small tint mismatch is minor.

## 6. Verdict contract

The evaluator writes one JSON document. The schema id is
`warren-ui-design-review/v1` and the rubric version is `1`.

```json
{
  "schema": "warren-ui-design-review/v1",
  "rubric": 1,
  "headSha": "<the PR head sha, equal to ci-meta.json headSha>",
  "verdict": "fail",
  "pagesInScope": ["runs"],
  "casesReviewed": [
    "runs.desktop.light", "runs.desktop.dark",
    "runs.phone.light", "runs.phone.dark"
  ],
  "findings": [
    {
      "criterion": "state-coverage",
      "severity": "blocker",
      "origin": "diff",
      "page": "runs",
      "viewport": "phone",
      "theme": "both",
      "evidence": "src/ui/src/pages/runs.tsx:212",
      "issue": "The empty state sits inside the hidden md:block table wrapper, so phone shows nothing.",
      "fix": "Render the EmptyState above the wrapper so both layouts share it."
    }
  ],
  "summary": "One blocker: the runs empty state is desktop-only."
}
```

Field rules:

- `page` is a page id from `PAGES`, or `shell` for the console shell.
- `viewport` is `desktop`, `phone`, or `both`. `theme` is `light`, `dark`,
  or `both`.
- `evidence` names a screenshot file (`runs.phone.dark.png`) or a diff
  location (`path:line`).
- `issue`, `fix`, and `evidence` are one line each, at most 200
  characters. `summary` is one line, at most 600 characters.
- Unknown fields are errors.

**Pass rule.** The verdict is PASS when the `diff` findings hold zero
blockers and at most two majors. Minors never fail a PR, and
`pre-existing` findings never count. The `verdict` field must equal the
result of this rule. A mismatch makes the document invalid.

**Fail closed.** A missing, unreadable, or invalid document is a FAIL.

**Validator.** `bun run scripts/design-review/verdict.ts <verdict.json>
--ci-meta <ci-meta.json>` prints one JSON line with `ok`, `verdict`,
`counts`, and `errors`. It exits 0 on a valid PASS, 1 on a valid FAIL,
and 2 on an invalid document or a stale artifact. The evaluator runs it
on its own output before it stops.

## 7. Contract for the design-review workflow

`warren-a694` builds the workflow. It can rely on these points.

- The workflow passes the skill the artifact directory, the diff, the
  pages in scope, and an output path.
- The workflow runs the validator itself and sets the `design-review`
  check from the exit code: 0 is success, and 1 or 2 is failure. It does
  not trust a verdict that the validator did not accept.
- The sticky comment lists the findings in the order that `rankFindings`
  returns: blockers, then majors, then minors, with `diff` before
  `pre-existing` at each severity.
- The evaluator has read access only. It never edits code, pushes, or
  comments. The workflow owns every write.

## 8. Changing the rubric

A change to a criterion's meaning, a severity, or the pass rule is a new
rubric version. Bump `RUBRIC_VERSION` in
`scripts/design-review/verdict.ts` and update this record in the same PR.
A new criterion also needs a new id in `CRITERIA`. The unit test in
`scripts/design-review/verdict.test.ts` fails when a criterion id has no
section here.

When the approved design changes in `docs/ui-revamp/`, update the
numbers in section 5 in the same PR.
