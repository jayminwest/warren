# Onboarding an external repo you do not control

Most warren docs assume the project repo is yours: you can commit
`.warren/` config, a `CONVENTIONS.md`, and CI wiring. This page is the
recipe for the other shape — a **mirror** of a repo you do not control
(foreign GitHub URL, no write access upstream) that you still want
agents to work on productively.

The whole trick is the **host-clone config path**: warren keeps a clone
of the project on the warren host (`<projects-root>/.../<repo>`), and
warren reads that clone's `.warren/config.yaml` on every dispatch.
`refreshProjectClone` never runs `git clean` — it fetches and checks
out, so an **untracked** `.warren/config.yaml` you write into the host
clone survives every refresh, forever. You get per-project defaults for
a repo whose upstream will never carry them.

That path works today and is the blessed way to configure a foreign
repo. `warren init --project <id>` scaffolds the two files into the
host clone for you.

## End-to-end mirror recipe

1. **Add the project** — point warren at the foreign URL:

   ```bash
   warren add-project --url https://github.com/someone/someone-repo
   ```

   (or `POST /projects` with the same fields). Warren clones it to the
   host and reports the project id.

2. **Scaffold config into the host clone:**

   ```bash
   warren init --project prj_xxxxxxxxxxxx
   ```

   This writes `.warren/triggers.yaml` and `.warren/config.yaml` into
   the host clone (never committed upstream — the files are untracked
   there and survive every refresh).

3. **Edit `.warren/config.yaml`** to describe the repo to the agents.
   The fields that matter most for a foreign repo:

   ```yaml
   # .warren/config.yaml — lives in the warren host clone, not upstream.
   repoContext: |
     This is a Python 3.12 repo managed with uv. The quality gate is
     `pytest -q` (no lint config in-tree). There is no issue tracker
     here — take the task statement in the prompt as the whole spec.
     Conventions: stdlib logging, no new top-level deps without a note.
   qualityGate: pytest -q
   defaultProvider: anthropic
   defaultModel: claude-sonnet-4
   runBranchPrefix: warren
   ```

   - **`repoContext`** (warren-540f) is the onboarding block. Warren
     injects it into **every dispatched agent's prompt**, between the
     agent's system section and the user's task, clearly delimited.
     This is where "this is a Python repo, the gate is `pytest -q`,
     there is no tracker here" lives. Free text, capped at 8 KiB —
     keep it to what an agent needs in its first five minutes. Its
     bytes are counted in the dispatch-context `prompt_bytes`.
   - **`qualityGate`** is the command warren tells the agent to run
     before committing (composeRunEnv carries it into the sandbox).
   - **`defaultProvider` / `defaultModel`** pin what the agents run
     on, so you do not have to pass them per dispatch.
   - **`maxCostUsd`** sets a project-wide per-run spend cap.
   - **`runBranchPrefix`** namespaces the branches warren pushes, so
     `warren/<run-id>` does not collide with the upstream naming.

   A per-project agent image override (`agentImage`) is landing under
   plan `pl-a37b` (warren-fabb) for repos whose gate needs a non-Bun
   toolchain — this page will grow the field when it ships.

4. **Dispatch** as usual — the mirror is now just a project:

   ```bash
   warren run prj_xxxxxxxxxxxx --role claude-code --prompt "Fix the flaky test in tests/test_cache.py"
   ```

   The agent's prompt arrives as `<agent system section> --- <repoContext> --- <your task>`, so it knows the stack and the gate before it opens a single file.

## Why this reaches every runtime

- **LocalProvider** reads the host clone directly — defaults and
  `repoContext` apply on every dispatch.
- **Docker / K8s**: the workspace init container clones from **origin**
   (the foreign URL), not the host clone — so the untracked
  `.warren/config.yaml` never appears in the run workspace. That is
  correct: the host clone is the control plane's copy, and control-plane
  reads (project defaults, quality gate, provider/model pinning) happen
  host-side at dispatch time. `repoContext` rides the composed prompt,
  so it reaches container and pod runs exactly the same way.

## Limits of the mirror shape

- **No upstream PRs from warren's identity.** If you cannot push to the
  origin repo, dispatch with a `targetBranch` on a fork, or accept that
  runs commit to the workspace branch only.
- **No in-repo `AGENTS.md`.** The upstream repo will not carry agent
  instructions; put everything an agent needs in `repoContext`. That is
  what the field is for.
- **No in-repo `.seeds/` / `.mulch/`.** Those features activate on
  directories inside the project repo. On a foreign mirror they stay
  off unless you own a fork that carries them.
