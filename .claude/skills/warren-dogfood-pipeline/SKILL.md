---
name: warren-dogfood-pipeline
description: Full prioritize → dispatch → shepherd → track pipeline against the live warren instance. Audits the seeds backlog around a focus theme, dispatches the surviving issues to warren agents one at a time, babysits the resulting PRs to merge (update-branch, conflict-repair runs, auto-merge), and closes the loop in the tracker. Activate for prompts like "run the dogfood pipeline", "dispatch the P1 <theme> issues to warren", "audit and dispatch", "work the backlog through warren agents".
---

# Protocol: Warren Dogfood Dispatch Pipeline

You run a themed slice of the seeds backlog end-to-end through the live
warren instance: audit → ordered dispatch list → sequential runs →
PR shepherding → tracker closure. Every run on the public instance is
also demo content, so prefer dispatching warren runs over doing the work
locally — including for repairs. The pipeline was proven 2026-07-28
(deletion pass: 9 issues, 15 runs, PRs #650–#658, plan pl-3a79 closed).

## 0. Inputs (ask if not given)

- **Focus theme + priority band** — e.g. "P0/P1 deletion-focused",
  "security leaks", "docs drift". This drives the audit lens.
- **Agent + model/provider** — ALWAYS stop and ask the operator
  (AskUserQuestion) which model + provider to use for all tasks in the
  session, even when every other input was given. Recommended default:
  provider `openrouter`, model `moonshotai/kimi-k3`, on the `pi`
  harness (the only harness that can reach OpenRouter; it is also the
  project `defaultRole`). Offer the anthropic tiers
  (`src/registry/builtins/model-tiers.ts`) as alternatives — for hard
  or large refactors use `claude-opus-5` (Opus 5; pass it as an
  explicit `modelOverride` — do NOT rely on the opus tier's default,
  which still pins the older claude-opus-4-8). Dispatch with explicit
  `providerOverride` + `modelOverride` matching the answer.
- **Dispatch mode** — sequential one-at-a-time (default, what the
  operator chose last time) vs parallel. Sequential means: next issue
  run dispatches only after the previous run is TERMINAL; repair runs
  are exempt and may overlap.
- **Blocked issues** — skip them, or dispatch their blockers first
  (last time: blockers first).

Report your understanding and the candidate list BEFORE dispatching
anything. Dispatching costs real money and opens real PRs.

## 1. Phase 1 — Audit & prioritize (subagent)

Spawn a subagent that invokes the `seeds-issue-audit` skill, with an
extra deliverable bolted on: a **DELETION-DISPATCH-LIST-style section**
for the focus theme — every still-open, in-theme issue with LIVE
blocker resolution (a closed blocker doesn't count; re-check each edge)
and a serial dispatch order, blockers first, sequenced so each run can
build on the previous merge. Require the exact line format
`<order>. <id> — <title> — <UNBLOCKED | blocked-by: ids>` so you can
dispatch straight off it.

Babysit the subagent: if it stops claiming to "wait for a worker
notification" while it has no live children, resume it and tell it to
finish the batch inline.

## 2. Phase 2 — Dispatch plumbing

- **Instance**: hostname lives only in the gitignored
  `deploy/k8s/overlays/gke-live/kustomization.yaml` (Ingress host
  patch). Token: `kubectl get secret warren-secrets -n warren -o
  jsonpath='{.data.warren-api-token}' | base64 -d` (key is
  `warren-api-token`, not `WARREN_API_TOKEN`).
- **Project id**: `GET /projects`, match the gitUrl.
- **Dispatch**: `POST /runs` with `{agent, project, prompt,
  modelOverride, seedId}`. Always pass `seedId` — it links the run to
  the tracker. BOTH `POST /runs` and `GET /runs/:id` WRAP the run as
  `{run: {...}}` — since warren-7d84 the detail GETs wrap to match the
  POST and the plan-runs family, so no route needs per-envelope
  knowledge. Parse `.run.state`, never `.state`. A bare parse reads
  all-null, which a polling loop silently reads as "not terminal yet"
  and spins to its iteration cap instead of failing loudly.
  Terminal states are `succeeded|failed|cancelled`.
- **Repair dispatch onto an existing PR branch**: same POST with
  `ref` = `targetBranch` = the PR's head branch. Warren pushes back to
  that branch in place; the agent must NOT open a new PR or branch.

**Prompt template per issue run** (adapt, keep all five elements):
1. "Work seeds issue <id>. First run `sd show <id> --json` from the
   repo root" — the issue body is the spec; your summary is a digest.
2. Context of what already merged on main that this run builds on.
3. Scope guidance (what to delete/change; repo-specific gotchas like
   `bun run check:bundle-size --update` for UI work).
4. "Quality gates are terminal: `bun run check:all` must be green
   before you commit and report done."
5. "Close the issue with `sd close <id> --reason ...`, then commit
   everything."

**Polling**: background loop, ~55s interval, ≤10 iterations per loop
(re-launch on expiry). Pipe curl straight into the JSON parser — never
round-trip response bodies through a shell variable + `echo` (zsh echo
expands `\n` inside the JSON and corrupts it). On terminal, capture
`state`, `failureReason`, `prUrl`, `costUsd`.

## 3. Phase 3 — Sequential loop with merge gates

- Next **independent** issue dispatches when the previous run is
  terminal.
- A **dependent** issue dispatches only when every blocker's PR is
  **MERGED on main** (re-verify with `gh pr view <n> --json state`
  immediately before dispatch) — a terminal run is not enough; the
  next clone needs the code.
- Interleave: put independent issues between a blocker and its
  dependents so PRs have time to merge while other work runs.

## 4. PR shepherding (expect to do this for EVERY PR)

Themed slices touch overlapping files (CLAUDE.md, budgets,
`.seeds/issues.jsonl`), so almost every PR that outlives another merge
goes stale. Diagnose with
`gh pr view <n> --json mergeable,mergeStateStatus,autoMergeRequest,statusCheckRollup`:

| State | Fix |
| --- | --- |
| `BEHIND`, auto-merge armed | `gh pr update-branch <n>` (re-run after every upstream merge — serial auto-merge is a chase) |
| `DIRTY` (conflicts) | FIRST verify the conflict is real: `git merge-tree --write-tree origin/main <head-ref>`. Clean (tree hash only) has TWO possible meanings — check whether the PR touches `.seeds/*.jsonl` before concluding: (a) PR does NOT touch `.seeds` → GitHub's cached mergeability is stale, push a merge commit to force a recompute, do NOT spend a repair run (warren-fb6e). (b) PR touches `.seeds` → the conflict is REAL for GitHub: the local `merge=seeds-jsonl` driver resolved an id-keyed row rewrite that GitHub's server-side merge genuinely cannot (it runs no custom drivers), so merge-tree-clean is NOT proof of a stale cache (warren-b34b). The `seeds-merge-autoheal` workflow pushes the driver-aware merge automatically; if it has not (or failed), do it manually: checkout the PR branch, `git merge origin/main --no-edit` (driver registered by `bun install`), verify `bun run check:seeds-integrity` + no duplicate ids, push. Genuinely conflicted even with the driver → dispatch a **repair run** on the PR branch (below) |
| `CLEAN`/green but auto-merge off | Article IX gate declined to arm it; `gh pr merge <n> --auto --squash` — only with operator authorization to unblock merges (ask once, then treat as standing for the session) |
| CI `FAILURE` | read the failing gate log; bundle-size overshoot after a merge → repair run that runs the bounded `check:bundle-size --update` and commits ONLY the budget diff |

**Repair-run prompt essentials**: name the PR and its issue; name what
merged on main since the branch was cut; `git fetch origin && git merge
origin/main`; preserve BOTH sides (deletions on main win over
incidental touches; this branch's feature always stays);
`.seeds/issues.jsonl` needs explicit attention even when git reports NO
conflict — `.gitattributes` routes it through the `merge=seeds-jsonl`
driver (a 3-way id-keyed merge registered by `bun install`), which is
correct ONLY in a clone where the driver is registered; verify
`bun run check:seeds-integrity` after any merge, and remember closing
one issue rewrites `blockedBy` on every plan sibling (warren-9c90 /
warren-db8c / warren-b34b).
Always run `jq -r .id .seeds/issues.jsonl | sort | uniq -d` after the
merge. Resolve by taking `closed` where either side closed and
INTERSECTING `blockedBy` — each side only ever removes a blocker, so
taking either row alone resurrects one the other side satisfied. Then
confirm with `bun run check:seeds-integrity`; budgets take main's numbers unless this branch
changed the UI; stay on the branch, no new PR, gate green, commit, no
push.

## 5. Known failure modes (all observed live)

- **Stale host clone on ref-dispatch** (warren-b94b): a repair run's
  workspace can miss a recent push to the same branch → reap push
  rejected non-fast-forward → `finalize_failed`, work discarded.
  Recovery: re-dispatch immediately (dispatch re-fetches), or fix
  locally in a throwaway `git worktree` and push.
- **noChanges seed auto-close** (warren-0395): a run that commits
  nothing can still close its `seedId` at reap. After any run that
  declined or no-op'd, verify the seed's status ON ORIGIN
  (`git show origin/main:.seeds/issues.jsonl`) and reopen if needed.
- **Lost closes in conflict-repair merges**: every `.seeds` conflict
  resolution risks dropping a close from one side. At wrap-up, verify
  EVERY dispatched seed's final status and re-close with evidence.
- **Sandboxed pre-commit hook**: warren's git-fixture tests escape
  their temp dirs under Claude Code's sandbox — they can commit fixture
  debris into the working tree and flip `core.bare=true` on the repo.
  Never let the `check:all` hook run sandboxed: commit data/docs-only
  changes with `--no-verify` (CI arbitrates), and run suspect
  git-fixture tests with the sandbox disabled. Repair: `git config
  core.bare false`.
- **Agent declines the issue**: an agent refusing work because the
  issue contradicts a shipped contract is SIGNAL, not failure. Read its
  reasoning from the run events, surface the design decision to the
  operator (AskUserQuestion with a recommended re-scope), then
  re-dispatch with the approved scope in the prompt — and have the run
  `sd update` the issue description first so the tracker matches.

## 6. Wrap-up (all steps, in order)

1. Verify every dispatched seed is closed on origin with an
   evidence-citing reason; restore lost closes. Record
   `sd plan outcome <pl> --result ...` if a plan completed.
2. File follow-up issues for every product bug the session surfaced
   (`sd create`) — dogfood yield is half the point.
3. `ml record` the failures/patterns worth keeping (with
   `--resolution` on failures).
4. `sd sync && ml sync`; if the hook blocks sandboxed, commit the
   `.seeds`/`.mulch` diff with `--no-verify`.
5. Rebase onto origin (main moved under you all session) and push;
   `git status` must end "up to date with origin". Do NOT trust push
   output alone — `remote: N of N required status checks are expected`
   appears on a SUCCESSFUL push and is easy to misread as a rejection
   (warren-53c0). After any push that touched `.seeds/`, verify the
   remote tip is clean:
   `git fetch origin && bun run check:seeds-integrity` against
   `git show origin/main:.seeds/issues.jsonl` (or the branch you
   pushed), and confirm `jq -r .id <(git show origin/<ref>:.seeds/issues.jsonl) | sort | uniq -d`
   is empty. The pre-push hook refuses a corrupt tip locally, but a
   misread of push output has still left a bad file on origin once.
6. Final report: table of issue → PR → merge state → cost, total spend,
   borderline items left for the operator, and the filed follow-ups.
