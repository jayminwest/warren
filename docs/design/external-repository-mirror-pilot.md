# External-repository mirror pilot

**Kind:** pilot
**Design state:** approved
**Delivery:** now
**Arrived:** 2026-08-20

Owner approval was recorded on 2026-08-20 and roadmap promotion on 2026-08-20.
This record fixes the pilot target set, operating model, experiment sequence,
and success criteria. Execution plans and structured study records live in the
private [`warren-experiments`](https://github.com/jayminwest/warren-experiments)
repository. It does not approve upstream pull requests, a router, replica
dispatch, or a new core feature campaign.

**Preferred first target:**
[`snakemake/snakemake`](https://github.com/snakemake/snakemake).

**Grounds:** [`corpus-flywheel.md`](./corpus-flywheel.md) steps 2–4 and §6;
[`agent-analytics.md`](./agent-analytics.md); and
[`onboarding-external-repos.md`](../onboarding-external-repos.md).

---

## 0. The outcome this pilot must produce

The pilot is not complete when Warren solves one historical issue. It is
complete when all of the following are true:

1. Warren works reliably on one unfamiliar, scientifically relevant
   repository.
2. Its work can be graded against executable evidence without exposing the
   accepted solution to the agent.
3. Every repository adaptation and every failure is classified and measured.
4. The onboarding process transfers to a second repository without relying on
   oral or session-specific knowledge.
5. A written runbook explains how to make the next external repository a good
   Warren workload.

The desired claim is deliberately bounded:

> A new scientific repository can be converted into a trustworthy, repeatable
> Warren workload through a documented process, with every adaptation and
> failure measurable.

The pilot stays entirely inside detached public mirrors. It sends no signal to
upstream repositories and opens no upstream pull requests.

## 1. Target shortlist

GitHub stars and forks below are approximate snapshots from 2026-08-20. They
measure community visibility, not scientific impact. Selection also weighs
research importance, current maintenance, recent accepted fixes, deterministic
tests, and the ability to run useful tasks without private data or GPUs.

### Tier A — pilot options

| Repository | Approximate visibility | Why it matters | Replay strengths | Main complications |
|---|---:|---|---|---|
| **[`snakemake/snakemake`](https://github.com/snakemake/snakemake)** | 2.8k stars, 650 forks | Widely used reproducible workflow engine across computational science, especially bioinformatics | Parser, DAG, workflow-language, and local-executor regressions can be small, deterministic, and issue-linked | The full product spans shells, Conda, containers, schedulers, storage, and plugins. First cases must avoid those integration-heavy edges. |
| **[`biopython/biopython`](https://github.com/biopython/biopython)** | 5.2k stars, 1.9k forks | Foundational general-purpose computational-biology toolkit | Mature CPU tests, small fixtures, and bounded parser, format, and algorithm bugs | Some modules call external services or executables. Its permissive custom/dual-license presentation needs notice preservation and a mirror-policy check. |
| **[`scverse/anndata`](https://github.com/scverse/anndata)** | 760 stars, 200 forks | Core annotated-data abstraction beneath Scanpy and much of the Python single-cell ecosystem | Compact repository with active work on indexing, serialization, and storage semantics | Optional Zarr, HDF5, Dask, cloud, and GPU paths complicate the complete matrix. |
| **[`scverse/scanpy`](https://github.com/scverse/scanpy)** | 2.5k stars, 760 forks | Central single-cell analysis toolkit with high scholarly impact | Rich issue and pull-request history; many CPU-local algorithms | Broader dependency stack, plotting, notebooks, graph methods, random seeds, and occasional flaky groups. |

### Preferred sequence

1. **Snakemake** is the first target by owner choice. Begin with parser, DAG,
   workflow-language, and local-executor cases only.
2. **Biopython or AnnData** is the transfer target. Biopython is the cleaner
   CPU baseline; AnnData is the compact, high-activity modern-Python baseline.
3. **Scanpy** follows once the method works on two repositories and is the
   first deliberate expansion into a broader scientific stack.

This order means Snakemake can expose realistic environment and integration
friction without allowing that friction to define the whole method. A second,
simpler Tier A repository tests whether the resulting process is general.

## 2. Experimental posture

The first cohort holds the dispatch arm fixed. It tests Warren and the
onboarding method, not model routing.

Initial protocol:

- one fixed agent, provider, model, and cost cap;
- five setup cases for Snakemake, excluded from headline results;
- five setup cases for the transfer repository, also excluded;
- the ten-run smoke gate across both repositories before either scored cohort;
- ten scored cases on each repository after that gate passes;
- CPU-local, deterministic tasks only;
- no credentials, private data, GPU, HPC scheduler, or large downloads;
- no model comparison, replica dispatch, or prompt tournament;
- infrastructure failures reported separately from agent failures;
- the accepted human patch remains hidden until grading; and
- no upstream PRs or issue activity.

The experiment changes one meaningful variable at a time. If the agent image,
prompt context, model, gate, and case definition all change together, the
result teaches nothing.

## 3. Two repository artifacts, not one

A checkout at a historical commit is not by itself a clean replay environment.
If the origin contains current branches, later tags, or reachable future Git
objects, the agent may discover the accepted fix with `git log --all`, a fetch,
or an upstream search.

Each selected project therefore has two related artifacts.

### 3.1 Detached public source mirror

The source mirror contains the current public upstream history and exists for
transparency, normal mirror work, and provenance. It is a newly created
repository, not a GitHub fork, so issue references and commits do not notify or
cross-link into the upstream project.

Its README states:

- this is an experimental Warren mirror;
- the canonical upstream URL;
- there is no upstream affiliation or endorsement;
- no work is submitted upstream during the mirror phase; and
- the mirror exists for reproducibility and agent-workflow research.

The mirror preserves the upstream license, copyright notices, and attribution.
Automation must not contact upstream with comments, issues, pull requests, or
status updates.

### 3.2 Sanitized replay execution origin

Each replay case runs against an origin that exposes history only through the
case's parent commit. It contains no branch, tag, remote, or reachable object
that reveals the accepted fix. Warren may push a result branch and open a
mirror-local PR against the historical base branch.

The first implementation may use one small execution repository per case.
That is operationally inelegant but scientifically clean. A replay harness can
later provision and retire these origins automatically.

A `baseCommit` pin reproduces the workspace cut, but it does not by itself
prevent future-history leakage. The sanitized origin and restricted network
are the leakage controls.

## 4. Mirror setup and safety controls

For each project:

1. Review the repository license and any data/model licenses.
2. Create a detached repository in the Warren mirror namespace.
3. Copy branches, tags, history, license files, and required attribution.
4. Add the experimental-mirror disclosure.
5. Give Warren write access only to the detached namespace.
6. Disable inherited workflows that publish, release, notify, or mutate
   external systems.
7. Add a pre-push check that refuses an upstream remote.
8. Reject full upstream issue and pull-request URLs from agent-authored commit
   messages. Local case identifiers replace them.
9. Protect mirror base branches from direct agent pushes.
10. Back up Warren's database and retain study runs for the duration of the
    experiment.

The public source mirror may ingest upstream changes. That update path is
one-way. No Warren artifact travels in the other direction.

## 5. Characterize the repository at current HEAD

Before historical replay, run a read-only onboarding investigation at current
HEAD. Capture:

- supported language and runtime versions;
- package and environment managers;
- build, lint, typecheck, format, and test commands;
- the narrowest useful test commands;
- native packages and external executables;
- services, credentials, and network access;
- CI jobs and which are reproducible locally;
- test-data locations, licenses, and sizes;
- CPU, memory, disk, and expected duration;
- random seeds and known flaky tests;
- contribution conventions and protected areas; and
- task classes suitable or unsuitable for replay.

The output becomes the first agent image, `repoContext`, `qualityGate`, and
friction record. Current-HEAD instructions are evidence, not an automatic
truth for older commits. Historical cohorts may need different runtime or gate
configurations.

## 6. Mine historical replay cases

Start with roughly 30 candidates and screen down to the setup and scored
cohorts.

### 6.1 Admission criteria

A preferred case:

- was fixed within roughly the last 6–12 months;
- has a public issue and an accepted fixing PR;
- has an unambiguous parent commit;
- adds or changes a regression test;
- was human-authored rather than Dependabot, release automation, or a backport;
- is runnable locally on CPU;
- needs no secret, private dataset, GPU, or large download;
- has a bounded change surface;
- has enough pre-fix issue context to specify the task; and
- does not reveal the solution in comments available at the cutoff.

For Snakemake's first cohort, prefer:

- parser and syntax regressions;
- DAG construction and dependency-resolution bugs;
- local-executor behavior;
- deterministic error reporting;
- workflow-language edge cases; and
- small API compatibility defects.

Defer scheduler plugins, cloud storage, Conda/Singularity/Apptainer behavior,
cluster execution, remote services, and environment-dependent integration
cases until the baseline works.

### 6.2 Historical prompt reconstruction

Archive the public task context as it existed at the cutoff:

- issue title and original body;
- labels;
- comments made before fixing work began;
- timestamps;
- parent commit;
- accepted PR and merge commit;
- relevant CI/runtime information;
- reference patch; and
- test-only portion of the patch, where separable.

Issue bodies can be edited after closure. A case with uncertain historical
wording is low-confidence or excluded. Later comments, review discussion,
release notes, and commit messages that disclose the fix do not enter the
agent prompt.

## 7. Validate the case before Warren sees it

Each admitted case gets a versioned manifest with:

- source project and local case id;
- upstream issue and PR ids kept in grader-only metadata;
- cutoff timestamp;
- exact 40-character parent SHA;
- accepted-fix SHA;
- historical task prompt;
- runtime and image digest;
- setup command;
- pre-existing test command;
- hidden regression-test patch;
- known network/data requirements;
- difficulty stratum; and
- eventual exclusion reason, if invalidated.

Then prove the benchmark itself:

1. Materialize the parent commit in a clean container.
2. Install from historical lock and configuration files.
3. Run the pre-fix baseline three times.
4. Apply the accepted human fix.
5. Run the post-fix baseline three times.
6. Confirm the target regression fails before and passes after.
7. Confirm no undeclared network, data, GPU, or service dependency.

If the accepted fix cannot be reproduced, the case is invalid. It is not a
Warren failure.

## 8. Configure Warren for the historical state

Historical configuration may differ from current HEAD.

### 8.1 Agent image

Pin an immutable image digest containing:

- the correct language/runtime version;
- system and native dependencies;
- package/environment managers; and
- ordinary build tools.

The image exists to reproduce the environment. It must not contain the
reference patch, future repository history, or issue-specific solution hints.

### 8.2 Repository context

Keep `repoContext` operational rather than solution-bearing. A Snakemake case
might receive:

```yaml
repoContext: |
  This checkout is a historical Snakemake revision.
  Treat the user task as the full issue specification.
  Run the narrow target tests first, then the configured quality gate.
  This case covers parser, DAG, workflow-language, or local-executor behavior.
  Network, Conda, container, scheduler, and cloud integration tests are out of scope
  unless the task says otherwise. Do not search upstream GitHub or later history.
qualityGate: <historically valid deterministic command>
agentImage: <immutable image digest>
defaultProvider: <fixed provider>
defaultModel: <fixed model>
maxCostUsd: <fixed study cap>
runBranchPrefix: warren-replay
```

Dispatch records:

- the historical base branch in `ref`;
- the exact parent SHA in `baseCommit`;
- a unique local case id in metadata;
- restricted network policy; and
- fixed provider/model/cap settings.

The result branch and mirror-local PR target the historical base branch, not
current `main`. Otherwise the diff includes unrelated changes after the case.

## 9. Classify the bending

External repositories will need adaptation. That friction is a primary output,
not noise to hide.

### Level 0 — upstream works unchanged

The documented lockfile, setup, and tests work. Warren supplies only the
runtime and ordinary credentials.

### Level 1 — control-plane overlay

No repository source changes:

- custom agent image;
- `repoContext`;
- environment variables;
- network policy;
- narrow deterministic quality gate; or
- dependency/cache setup.

Warren is adapting to the project while leaving the source faithful.

### Level 2 — mirror readiness patch

Mirror-only source changes:

- `AGENTS.md`;
- a `verify` wrapper;
- deterministic test exclusions;
- pinned dependency repairs;
- local fixtures replacing unstable network dependencies; or
- a local mapping of upstream CI commands.

These changes are legitimate but must be explicit. Selected paired cases run
both without and with the readiness layer so its effect is measurable.

### Level 3 — Warren or replay-harness improvement

Repeated cross-project friction may purchase a general capability, such as:

- better image selection;
- cache support;
- environment diagnostics;
- setup-failure classification;
- hidden-test application;
- historical-origin provisioning; or
- stronger future-history leakage prevention.

A foreign repository pays for the feature. One idiosyncratic repository does
not automatically justify core work.

### Level 4 — case or repository exclusion

Examples include private data, unavailable dependencies, mandatory GPU/HPC
execution, unbounded services, or no executable correctness signal. Knowing
when to defer is part of a trustworthy workflow.

### Friction record

Every adaptation records:

- what and where it failed;
- category: repository, environment, Warren, agent, or benchmark;
- one-off versus generalizable;
- operator time spent;
- source changes required;
- whether the adaptation changed outcomes; and
- where the durable fix belongs.

## 10. Smoke gate

The five setup cases are not scored as capability results. They prove the
experimental apparatus:

- historical SHA materializes correctly;
- future history and upstream search are unavailable;
- intended image, provider, model, and cap are used and recorded;
- retry lineage is unambiguous;
- normalized events and dispatch context are complete;
- result branches push only to the detached origin;
- mirror-local PRs target the historical base;
- existing gates execute;
- hidden tests can be applied after the run; and
- failures can be assigned to a named category.

The scored cohorts begin after ten consecutive setup runs — five on Snakemake
and five on the transfer repository — show correct dispatch context and no
unexplained configuration or execution changes. This gate deliberately delays
Snakemake scoring until the transfer setup proves that the apparatus is not
Snakemake-specific.

## 11. Scored replay

For each repository, dispatch 10–15 blinded cases using the fixed arm.

After a run finishes:

1. Apply the hidden regression tests from the accepted fix.
2. Run the agreed complete quality gate.
3. Compare behavior with the reference solution, not just patch similarity.
4. Conduct a bounded human review.
5. Attach the judge verdict as an interpretation, not ground truth.

Report four separate dimensions.

### Infrastructure

- checkout/materialization;
- image and dependency setup;
- sandbox and network behavior;
- event capture;
- reap, push, and PR creation; and
- grader operation.

### Task correctness

- pre-existing tests;
- hidden regression tests;
- behavioral equivalence;
- scope completeness; and
- manual scientific or API review where unavoidable.

### Agent behavior

- clean;
- partial;
- wrong approach;
- requirement miss;
- gate flunk;
- no change; or
- excessive scope.

### Economics

- cost;
- duration;
- retries;
- review minutes;
- files changed; and
- diff size.

No single success percentage collapses these dimensions. Every rate publishes
its denominator and the number of rejected or invalid benchmark cases.

## 12. Hardening loop on Snakemake

After each cohort:

1. Aggregate the friction log.
2. Select the most frequent or expensive failure class.
3. Decide whether the remedy belongs in Warren, the replay harness, the agent
   image, `repoContext`, a readiness patch, or case admission.
4. Change one layer.
5. Re-run the same paired cases.
6. Measure the effect.
7. Add the result to the onboarding runbook.

Snakemake is considered operationally strong when:

- at least 95% of admitted cases materialize, launch, record, push, and grade
  without manual infrastructure repair;
- historical baseline tests reproduce reliably;
- setup and environment failures stay below 5–10%;
- every failure belongs to a known category;
- normal Git and network access cannot reveal the reference solution;
- every run has correct dispatch context and retry lineage;
- mirror-local PRs show clean, reviewable historical diffs;
- small mechanically verifiable tasks reach a useful solve rate, with the
  exact threshold set after calibration rather than invented in advance;
- review time and cost have predictable measured distributions; and
- a new case can be admitted without editing Warren itself.

"Admitted cases" is an explicit denominator. Case rejection rules and counts
remain visible so the score cannot be improved by silent cherry-picking.

## 13. Prove transfer to a second Tier A repository

Biopython or AnnData is onboarded using only the written process. Prefer a new
operator or, at minimum, a fresh context without Snakemake-specific knowledge.

The operator must be able to:

1. characterize the repository;
2. build and pin the agent image;
3. write `repoContext` and the gate;
4. mine and validate candidate cases;
5. provision sanitized origins;
6. run smoke and scored cohorts; and
7. produce the same scorecard and friction taxonomy.

The method is portable when:

- the second repository reaches operational readiness within approximately one
  working day or another pre-declared budget;
- no Warren core feature is required merely to make a normal run function;
- repository-specific adaptations stay in declared overlays;
- the same case manifest and outcome taxonomy work unchanged;
- at least 90–95% of admitted cases execute and grade; and
- friction falls materially compared with Snakemake.

Success on Snakemake proves Warren can be made to work on Snakemake. Transfer
proves the onboarding method.

## 14. Deliverables

The first milestone leaves:

1. detached, clearly labeled mirrors for the selected projects;
2. sanitized execution origins or a repeatable factory for them;
3. at least 20 validated historical cases across two repositories;
4. pinned agent images and versioned Warren overlays;
5. archived historical issue prompts and grader-only reference artifacts;
6. a structured friction log;
7. per-repository scorecards;
8. a failure taxonomy separating Warren, environment, agent, and benchmark;
9. a reproducible onboarding runbook;
10. a no-upstream-contact and no-future-history proof;
11. a list of general Warren improvements purchased by observed friction; and
12. a recommendation for the next target: Scanpy or a harder second-wave
    repository.

## 15. Explicit non-goals

This pilot does not include:

- upstream pull requests or issues;
- automatic contribution submission;
- a learned router or contextual bandit;
- replica or parallel dispatch waves;
- cross-project scheduling or Colonies;
- verdict-ranked core review surfaces;
- a generic full-history mining pipeline;
- a new memory system;
- benchmark claims based on patch similarity alone; or
- forcing every scientific repository through Warren regardless of its data,
  hardware, or validation constraints.

Those items return only when pilot evidence creates a payer.

## 16. Decision points after the pilot

The evidence determines, in order:

1. whether Snakemake remains a good long-running workload;
2. which adaptations belong in Warren versus the replay extension;
3. whether human review volume justifies a review queue;
4. whether the verdict-ingest decision in `warren-9236` is now required;
5. whether a descriptive router has enough clean episodes to start in shadow
   mode; and
6. whether the next repository should add scientific breadth, software-stack
   diversity, or infrastructure difficulty.

Until then, the mirrors are the feature campaign: use foreign repositories,
measure the friction, and let observed failures choose what Warren builds next.
