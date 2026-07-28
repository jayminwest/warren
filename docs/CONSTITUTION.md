# The Warren Constitution

Taste, compiled. This document is the standard merged work is measured
against — by humans reviewing PRs, and by any agent warren dispatches
against this repo. Cite articles by number. The quality gates in CI
enforce what they can; these articles cover what executable gates
cannot — and every article aspires to become a gate.

There is no standing audit population. Warren ran one from 2026-06 to
2026-07 (gatewatch, ratchetwatch, tastewatch, warden-digest on nightly
and weekly crons); it was retired 2026-07-28 (warren-a781) because it
billed tokens to restate findings the gates already enforced, at a rate
nobody triaged. Enforcement lives in CI and in human review. See
`.warren/triggers.yaml` for what remains scheduled (nothing) and why.

Provenance: distilled 2026-06-11 from CLAUDE.md conventions, mulch
records, and a forensic audit of merged history (the PR #270
title/diff mismatch, the silent 91.62% → 90.82% coverage decay inside
ratchet slack, the v0.7.1 supervisor-entry production break, four
files grandfathered at birth on 2026-06-06, and 8 releases in 10 days
carrying mostly comment fixes).

## Article I — Merges are truthful

A PR's title and description describe its diff. A feature-titled PR
contains the feature. A merge is never rationalized past a red gate
("this failure is unrelated" is a finding, not a waiver — fix the gate
or fix the change). If work is blocked, the PR says it is blocked and
carries no feature title.

## Article II — Ratchets only tighten

Coverage floors rise to track actuals; slack above ~0.75pt is debt.
Budget and grandfather exceptions carry a tracker reference in the
diff that adds them. Nothing is grandfathered at birth: a new file
written over the size limit is decomposed before merge, not exempted
at write time. Automated budget raises (autoheal) stay within their
caps and are reviewed in aggregate, not ignored individually.

## Article III — Releases mean something

A published release contains at least one consumer-observable change.
Internal hygiene (comment fixes, doc drift, test tightening) batches
into the next real release rather than minting its own. Patrol plans
release conditionally, not ceremonially.

## Article IV — Tests verify behavior

Coverage gains come from meaningful assertions, not test theater.
Aggregation, classification, and parsing logic ships with adversarial
cases — malformed input, boundary values, the case that broke last
time — not happy-path only. A test that asserts a mock was called is
documentation, not verification.

## Article V — Comments state constraints

Per CLAUDE.md: a comment exists to state a constraint the code cannot
show. Institutional memory belongs in mulch records, not in 200-word
JSON `$comment` essays. Narration of the obvious is noise and gets
removed, not preserved.

## Article VI — Refactors prove runtime paths

Any file move or rename verifies references that tests do not import:
Dockerfile entrypoints, supervisor spawn paths, workflow YAML, config
strings, docs. The check is a repo-wide search for the old path,
including non-source files. "All gates green" is not "deploy works."

## Article VII — Identity is consistent

Agent-authored commits use canonical co-author identities. One agent,
one spelling. An identity that appears once and never again is a
finding.

## Article VIII — Evidence or it didn't happen

Findings cite commit SHAs, file paths, and line ranges. A seed filed
without evidence gets closed without action. An agent that cannot show
its work does not file.

## Article IX — The constitution outranks the population

Changes to this file, to `.warren/triggers.yaml`, or to the agent
definitions in `src/registry/builtins/` require explicit human review —
they must not ride an auto-merged PR. An agent does not rewrite the
standard it is measured against, and does not schedule itself.

Executable form: the "Article IX check" step in
`.github/workflows/auto-merge.yml` refuses to enable auto-merge on any
PR touching this file, `.warren/triggers.yaml`, `.canopy/`, or that
workflow itself. The gate can be deleted; the deletion is itself a
protected change, so a human sees it.

## Amendments

Amend by PR touching this file, flagged for human merge (Article IX).
An agent may propose an amendment; only a human merges one. When an
article becomes fully enforceable as an executable gate, note the gate
here and retire the manual check.

---

## Agent reporting boundary

Any agent warren dispatches against this repo records its findings
**only** as seeds issues via the `sd` CLI. No agent writes to the
database directly or calls a new endpoint to report. The seed is the
durable record, as reviewable as any other seed.

This is what makes Article IX hold: an agent's output is a proposal in
the tracker, never a change to the standard it was measured against and
never a change to its own schedule.
