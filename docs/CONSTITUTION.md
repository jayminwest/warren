# The Warren Constitution

Taste, compiled. This document is the standard the audit population
(gatewatch, ratchetwatch, tastewatch — see `.warren/triggers.yaml`)
measures merged work against. Auditors cite articles by number when
filing findings. The quality gates in CI enforce what they can;
these articles cover what executable gates cannot — and every article
aspires to become a gate.

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
without evidence gets closed without action. Auditors that cannot show
their work do not file.

## Article IX — The constitution outranks the population

Changes to this file, to auditor prompts (the agent entries for
gatewatch / ratchetwatch / tastewatch — today `agents/*.md`, historically
rendered under `.canopy/`; the `.canopy/` references here are struck in
the phase-C canopy sweep, warren-6fcd), or to `.warren/triggers.yaml`
audit entries require explicit human review — they must not ride an
auto-merged PR. Any auditor that observes a merged change to these
files without human approval files a priority-1 finding citing this
article. The population does not rewrite its own mandate.

Executable form: the "Article IX check" step in
`.github/workflows/auto-merge.yml` refuses to enable auto-merge on any
PR touching this file, `.warren/triggers.yaml`, `.canopy/`, or that
workflow itself. The auditors still verify (the gate can be deleted;
the deletion is itself a protected change).

## Amendments

Amend by PR touching this file, flagged for human merge (Article IX).
Tastewatch's weekly digest may propose amendments; it may not apply
them. When an article becomes fully enforceable as an executable gate,
note the gate here and retire the manual check.

---

## Audit Warden boundary (warden architecture)

The Audit Warden consolidates findings from gatewatch, ratchetwatch, and
tastewatch into a weekly digest. This section records the constitutional
constraints.

> **Retired (warren-e7e7 / pl-3a79):** the warden was formerly a standing
> Leveret conversation bound to a long-lived meta-Plot, fed over
> `POST /conversations/:id/messages` and re-woken via
> `POST /conversations/:id/re-wake`. The conversations subsystem is being
> removed; the warden now operates entirely over seeds issues. All
> `/conversations*` references below have been struck.

### Ingestion rule

Audit findings are recorded **only** as seeds issues via the `sd` CLI
(labeled `audit` plus the auditor's own label). No auditor writes
directly to the DB or calls a new endpoint. The seed is the durable,
auditable record — this preserves Article IX: auditors cannot modify
their own mandate, and every finding is as reviewable as any other seed.

### Digest cadence

- `warden-digest` cron: Sunday 05:00 America/Los_Angeles — the digest
  driver triages the week's accumulated open `audit`-labeled seeds and
  files one consolidated digest seed (and, where mechanical, a plan).
- `tastewatch-digest` cron: Sunday 04:00 America/Los_Angeles (60 min
  before warden-digest) — tastewatch files its taste digest seed first
  so warden-digest can synthesize it alongside the other auditors'.

Both trigger entries are in `.warren/triggers.yaml` and are protected by
Article IX (require human review to change).

### Autonomy-promotion recommendations

When tastewatch's precision table shows consistent, high-precision findings
from an auditor, tastewatch *recommends* autonomy promotion in its digest.
These recommendations are advisory — they are recorded in the digest seed
for a human to route as a proposed seed or amendment, and any resulting
change to `.canopy/` or `.warren/triggers.yaml` requires explicit human
review (Article IX). No auditor may grant itself or another auditor
autonomous dispatch authority.
