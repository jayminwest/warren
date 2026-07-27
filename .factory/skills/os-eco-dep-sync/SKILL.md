---
name: os-eco-dep-sync
description: Bump warren onto the latest published @os-eco/* versions across package.json + bun.lock and the Dockerfile CLI pins, then run the gates and open a PR. Use when checking if warren is on the newest burrow/plot/canopy/seeds/mulch/sapling.
tools:
  - bun
  - npm
  - git
  - gh
inputs:
  - package (optional) — restrict to one os-eco tool, e.g. burrow; default is all
outputs:
  - updated package.json + regenerated bun.lock with caret ranges on latest
  - updated Dockerfile global-install pins on latest
  - a focused commit on main (gates green)
---

# os-eco-dep-sync

Use this skill inside the **warren** repo when you need to confirm warren is
running the newest published versions of the other os-eco tools and bump it if
not. Warren is the only ecosystem consumer, and it tracks the rest of os-eco
across **two surfaces** that must stay in lockstep:

1. **npm dependencies** in `package.json` (+ `bun.lock`):
   `@os-eco/burrow-cli` and `@os-eco/plot-cli`. These are what warren builds
   and imports against — consumed as published registry packages, not links.
2. **Global CLI pins** in the `Dockerfile` `bun install -g` block: all six
   bundled CLIs — `@os-eco/burrow-cli`, `@os-eco/plot-cli`,
   `@os-eco/canopy-cli`, `@os-eco/seeds-cli`, `@os-eco/mulch-cli`,
   `@os-eco/sapling-cli` — that back warren's opt-in features at runtime.

"Latest" always means the **published npm version** (`npm view ... version`),
never the local sibling working tree.

> **The burrow double-pin invariant.** `@os-eco/burrow-cli` (and `plot-cli`)
> appears in *both* surfaces. `Bun.spawn` resolves `./node_modules/.bin/burrow`
> before PATH, so bumping only the Dockerfile is a silent no-op — the
> supervisor keeps running the lockfile copy. The two pins MUST be identical.
> See `CLAUDE.md` → "Relationship to burrow".

## Pre-flight

```bash
cd warren                         # this skill operates only on the warren repo
git status                        # MUST be clean before you start
command -v bun npm git gh         # gh optional (only for the PR step)
```

If the tree is dirty, stop and let the user commit or stash first — this skill
ends in a focused, reviewable commit and a noisy tree defeats that.

Read the current pins so you know the starting point:

```bash
grep '@os-eco/' package.json
grep '@os-eco/' Dockerfile
```

## Procedure

### 1. Discover the latest published version of each tool

```bash
for t in burrow plot canopy seeds mulch sapling; do
  printf '%-8s %s\n' "$t" "$(npm view @os-eco/$t-cli version)"
done
```

If `inputs.package` was given, restrict the loop to that one tool. Record each
`latest`. Compare against the pins printed in pre-flight; anything behind is a
bump target. If every surface already matches latest, report "warren is
up to date" and stop — do not create an empty commit.

### 2. Bump the npm dependencies (package.json + bun.lock)

For each lagging entry in `dependencies` (`burrow-cli`, `plot-cli` only), set
the caret range to the latest published version, then regenerate the lockfile:

```bash
# edit package.json: "@os-eco/burrow-cli": "^<latest>", "@os-eco/plot-cli": "^<latest>"
bun install                       # regenerates bun.lock to resolve the new range
grep -A1 '@os-eco/burrow-cli' bun.lock   # confirm the resolved version == latest
```

Edit `package.json` with the editor, not by hand-piping into the file. Keep the
existing caret (`^`) style — match the surrounding manifest.

### 3. Bump the Dockerfile global pins

In the `RUN bun install -g` block, update every lagging `@os-eco/<tool>-cli@X.Y.Z`
to its latest published version (exact pin, no caret — that block is
deliberately pinned). Cover all six tools, not just the two npm deps:

```bash
grep -n '@os-eco/.*-cli@' Dockerfile     # verify each line now reads the latest version
```

**Enforce the double-pin invariant:** the `burrow-cli` and `plot-cli` versions
in the Dockerfile MUST equal the versions `bun.lock` resolved in step 2. If
they disagree, the supervisor and the bundled CLI diverge at runtime.

### 4. Keep warren's own VERSION in sync and ship the bump

A dependency bump is a release, so bump warren's own patch version. Use the
script — it rewrites every version site at once and rolls back on failure:

```bash
bun run version:bump patch
grep '"version"' package.json
grep 'export const VERSION' src/index.ts   # the two strings MUST match —
                                           # release.yml fails the job otherwise
```

Add a `CHANGELOG.md` entry for the new version describing the os-eco bumps
(the release workflow pulls notes from the matching section).

### 5. Run the gates

```bash
bun run check:all                 # the full suite CI enforces; warnings fail
```

If burrow/plot shipped a breaking change, this is where typecheck or tests
catch it. Fix forward against the new version or, if the break is real and out
of scope, stop and report it rather than pinning back silently.

### 6. Commit to main

Commit directly to `main` — do **not** create a feature branch or open a PR
for this sync. Stage only the touched surfaces and write one focused commit:

```bash
git add package.json bun.lock Dockerfile src/index.ts CHANGELOG.md docs/openapi.yaml
git commit -m "chore: sync os-eco deps to latest published versions"
```

(`docs/openapi.yaml` only changes if the VERSION bump in step 4 re-baselined
it via `bun run gen:openapi`; include it when it shows in `git status`.)

Do not `git push` unless the user asked for it — leave the commit local and
report that it's on `main`.

## Acceptance

- `npm view @os-eco/<tool>-cli version` equals the pin for that tool in **both**
  `package.json` (for burrow/plot) and the `Dockerfile` (for all six).
- `bun.lock` resolves `burrow-cli`/`plot-cli` to those same versions, and the
  Dockerfile's `burrow-cli`/`plot-cli` pins match the lockfile (double-pin held).
- `package.json` `"version"` equals `src/index.ts` `VERSION`.
- `bun run check:all` exits 0.
- One focused commit on `main` (no feature branch, no PR); tree otherwise clean.

## Failure modes

| Symptom | Cause | Remedy |
|---|---|---|
| Supervisor runs an old burrow despite a Dockerfile bump | `Bun.spawn` resolves the local `node_modules/.bin/burrow` first | Bump burrow in `package.json` + `bun.lock` too; keep both pins equal (step 2 + 3) |
| `release.yml` fails "Verify version sync" | `package.json` version ≠ `src/index.ts` VERSION | Edit both to the same string (step 4) |
| `npm view` returns empty / errors | tool not published, typo'd name, or offline | Confirm the exact `@os-eco/<tool>-cli` name; skip tools with no published release |
| `check:all` fails on typecheck after a bump | upstream shipped a breaking change | Adapt warren to the new API, or report and hold the bump for that tool only |
| `bun install` leaves bun.lock unchanged | caret range already admitted the latest | Confirm whether a manifest bump is actually needed; the lockfile may already be current |

## Further reading

- `CLAUDE.md` → "Relationship to burrow" and "Version Management" — the
  double-pin rule and the two-place version contract.
- `Dockerfile` — the `bun install -g` block that bundles the six os-eco CLIs.
- `.github/workflows/release.yml` — the version-sync gate, tag, and GitHub
  release. Deploy is decoupled: `.github/workflows/deploy-gke.yml` rolls GKE
  forward on a published release.
