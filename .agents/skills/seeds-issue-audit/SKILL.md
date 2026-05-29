---
name: seeds-issue-audit
description: Audit and triage open Seeds (sd) issues — find which can be closed, auto-close high-confidence completed ones, and report borderline cases. Activate for prompts like "audit open issues", "which seeds issues can be closed", "clean up the issue tracker", "triage the seeds backlog".
---

# Protocol: Seeds Issue Audit & Triage

You audit the project's open Seeds (`sd`) issues, decide which are safely
closeable, auto-close only the high-confidence completed ones, and report
everything borderline for a human to review. You NEVER guess: every
auto-close must cite concrete evidence. Staleness alone is never enough to
close anything.

## 1. Operating Principles
- **Auto-close only HIGH confidence.** A HIGH-confidence issue has at least
  one strong completion signal AND no unresolved blockers. Close it.
- **Report, never close, BORDERLINE.** Weak/partial/ambiguous signals are
  surfaced in the report for a human — you do not touch them.
- **Leave contradicted issues open.** Open blockers, "WIP" / "in progress"
  language, or a reopened history means NOT closeable, full stop.
- **A blocker only counts if it is still OPEN.** `sd blocked` / `sd ready`
  membership is a SNAPSHOT, not proof — a "blocked" issue may be sitting
  behind a blocker that is already `closed` (stale dependency edge), and its
  work may be fully shipped. Audit the blocked set too; never auto-exclude
  it. Re-resolve every blocker's LIVE status before trusting the gate.
- **Cascade until the set stabilizes.** Closing an issue can unblock its
  downstream consumers. After every close pass, RE-AUDIT anything that was
  blocked solely by the issues you just closed — its work may already be
  done and merely waiting on a stale edge. Loop until a pass closes nothing.
- **Plans drift ahead of their seeds.** A plan can be fully implemented and
  released while its child seeds stay open. Always reconcile plans against
  shipped code (Section 2) — don't trust `plan_status`/`open` child seeds at
  face value.
- **Evidence-first.** Seeds has no first-class PR/commit field — references
  live only in free-text `description` / `closeReason`. Confirm them against
  git / `gh` before trusting them.
- **`sd close` is the only mutating command you run** (plus `sd sync` to
  commit and `sd plan outcome` to record a finished plan). It is reversible
  via reopen. Never run `sd update` on others' issues; never push.

## 2. Recon (always run first, read-only)
Count the open set to pick an execution mode and gather candidates:

```bash
sd stats                       # totals by status/type/priority
sd list --format ids           # bare open issue ids, one per line (fast)
sd list --format compact       # "id Priority status title" one-liner (fast)
sd ready --json                # open issues with NO unresolved blockers
sd blocked                     # issues that ARE blocked (audit too — see below)
```

- `sd ready` is the closeable-candidate gate for the FIRST pass — but it is a
  snapshot. Audit BOTH the ready set and the blocked set. The blocked set's
  edges are frequently stale: a "blocked" issue may sit behind a blocker that
  is already `closed`, with its own work fully shipped. Never silently
  exclude blocked issues from the audit.
- For every blocked issue, resolve each blocker's LIVE status (`sd dep list
  <id>`, then `sd show <blocker>` if unsure). If all blockers are already
  closed, the issue is auto-close-eligible and must be scored like any other.
- **Reconcile plans against code.** If any open issue carries a `plan_id`, or
  recon shows active plans, run `sd plan show <pl-id>` and walk its steps. A
  plan whose phase PRs have all merged/released is materially DONE even if
  several child seeds are still open — those children are stale-open and
  should be verified (Section 4) and closed. After closing all of a plan's
  children, record `sd plan outcome <pl-id> --result success`.
- Avoid `sd list --json` over the full open set — it embeds full
  descriptions and is SLOW / may time out. Page it or use per-issue
  `sd show <id> [more ids] --json` (single or batched ids are fast).

## 3. Choose Execution Mode (adaptive by open-issue count)
Count open issues with `sd stats` or `sd list --format ids | wc -l`, then:

| Open issues | Mode |
| --- | --- |
| `<= 15` | **INLINE** — audit every issue yourself in this agent. |
| `> 15` | **FAN OUT** — split ids into batches (~10 per batch) and dispatch one parallel `worker` subagent per batch via the Task tool. |

In FAN OUT mode, each worker audits its batch (Sections 4–5) and returns a
structured per-issue verdict. The orchestrator then aggregates all verdicts,
performs the auto-closes itself (Section 6), and compiles the report
(Section 7). Workers MUST NOT run `sd close` / `sd sync` — auditing only.

### Required worker return format (one block per issue)
```
- id: <issue-id>
  title: <title>
  score: <integer>
  signals: [<merged-pr|plan-done|blockers-clear|stale|wip|...>]
  recommendation: <auto-close | report-borderline | leave-open>
  close_reason: "<proposed concise evidence-based reason, or empty>"
```

## 4. Gather Signals (per issue)
Pull the full record and scan it:

```bash
sd show <id> --json            # id, status, type, priority, createdAt,
                               # updatedAt, description, closeReason,
                               # labels, blockedBy, blocks, plan_id,
                               # plan_status, parentId, extensions
sd dep list <id>               # list "Blocked by" edges
```

For EVERY blocker listed, confirm its LIVE status — a blocker that is already
`closed` does not count. Do not infer "blocked" from `sd blocked` membership
alone; resolve the actual edge:

```bash
sd show <blocker-id> --json | grep -E '"status"'   # closed blocker ≠ a blocker
```

If the issue carries a `plan_id`, pull the plan and map this issue to its step
so you can judge it against sibling progress and shipped PRs:

```bash
sd plan show <plan-id>         # steps, child seeds, blocks edges, status
```

Extract references from `description` + `closeReason` (the only place PRs /
commits appear) with these patterns:

| Reference | Regex |
| --- | --- |
| PR / issue number | `#\d+` |
| Plan id | `pl-[0-9a-f]+` |
| Warren tracker id | `warren-[0-9a-f]+` |
| Commit SHA | `\b[0-9a-f]{7,40}\b` |
| Completion language | `merged`, `done`, `closed`, `shipped`, `landed` |

Confirm references are REAL completions (best-effort; `gh` is optional):

```bash
git log --oneline --all | grep -iE "<issue-id>|#<pr-number>|<sha>"
gh pr view <N> --json state,merged   # state=MERGED / merged=true → confirmed
```

A PR reference counts as a strong signal only when `gh` reports it MERGED, or
the commit/PR is found on the default branch via `git log`.

## 5. Score & Decide (weighted rubric)
Score each issue, then map to a verdict.

**Signals & weights**
- **Merged PR / commit confirmed** (gh `merged=true`, OR commit/PR on default
  branch): **strong (+3)**.
- **`plan_status == "done"`** for the issue's plan, paired with completion
  language: **strong (+3)**.
- **`blockedBy` empty OR every listed blocker already `closed`**: **required
  gate** (+1). If ANY blocker is still open → NOT auto-closeable, period.
- **Staleness**: `updatedAt` older than the threshold (**default 90 days**,
  override if the user prompt specifies one): **weak (+1), flag-only**.
  Staleness ALONE never auto-closes.

**Confidence bands**
- **HIGH (auto-close):** at least one strong signal AND no unresolved
  blockers AND no contradiction.
- **BORDERLINE (report only):** only weak/partial signals, an unconfirmed PR
  reference, stale-but-otherwise-quiet, or any ambiguity.
- **NOT CLOSEABLE (leave open):** any open blocker, "WIP"/"in progress"
  language, or evidence the work is unfinished/reopened.

**Decision table**

| Strong signal? | Blockers clear? | Other signals | Verdict |
| --- | --- | --- | --- |
| Yes (merged PR / plan done) | Yes | — | **AUTO-CLOSE** |
| Yes | No (open blocker) | — | LEAVE OPEN |
| No | Yes | unconfirmed PR ref / completion language only | **REPORT BORDERLINE** |
| No | Yes | stale only (`updatedAt` past threshold) | **REPORT BORDERLINE** |
| No | Yes | none / fresh / no signals | LEAVE OPEN |
| Any | Any | "WIP" / reopened / unfinished | LEAVE OPEN |
| — | — | `status == in_progress` | REPORT (never auto-close w/o explicit OK) |

## 6. Closing Protocol (orchestrator only)
Close ONLY the HIGH-confidence set. Cite the signal in every reason.

```bash
# Close one — reason cites concrete evidence
sd close <id> --reason "PR #197 merged; plan pl-55a3 done"

# Batch-close ONLY when issues share the exact same reason
sd close <id1> <id2> <id3> --reason "shared evidence here"
```

- Prefer individual closes so each `--reason` is accurate; batch only when
  the reason genuinely applies to all.

**Cascade re-audit (mandatory after every close pass).** Closing an issue can
clear the last open blocker of a downstream issue. Before you sync:

1. Collect the issues that were blocked SOLELY by the ones you just closed
   (`sd ready` will now list newly-unblocked items; cross-check against the
   `blocks` edges of the closed set).
2. Re-audit each (Sections 4–5) with its blockers now resolved. Many will be
   stale-open work that already shipped — verify evidence and auto-close the
   HIGH-confidence ones.
3. Repeat until a full pass closes nothing (the set has stabilized).

This is how a fully-shipped-but-unclosed plan chain gets caught: closing the
early phases unblocks the later phases, whose PRs already merged.

- When you have closed every child of a plan, record the outcome:

```bash
sd plan outcome <plan-id> --result success   # or partial / failure
```

- After all close passes and cascades settle, stage/commit the `.seeds/`
  changes:

```bash
sd sync
```

- Do **not** push — the user pushes per the repo session-completion protocol.

**Hard safety rules**
- Never close an issue with a blocker that is still OPEN (a `closed` blocker
  does not count — verify live status, don't trust the `blocked` snapshot).
- Never auto-close an `in_progress` issue without explicit user confirmation.
- Staleness-only is never an auto-close.
- If evidence is unconfirmed or contradictory, downgrade to BORDERLINE.

## 7. Final Report
End with a concise, scannable summary — two tables.

**Auto-closed**

| id | title | reason |
| --- | --- | --- |
| ... | ... | evidence-based close reason |

**Borderline (needs human review)**

| id | title | signals | why not auto-closed | suggested action |
| --- | --- | --- | --- | --- |
| ... | ... | stale 140d; PR #x unconfirmed | no confirmed completion signal | verify PR #x merged, then close |

Optionally render these with the `<json-render>` Table / Card components for
the terminal UI. Lead with the counts (e.g. "Closed 6, flagged 9 borderline,
left 29 open") so the outcome is obvious at a glance.
