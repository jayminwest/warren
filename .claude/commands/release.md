---
name: release
description: Prepare, cut, and verify a warren release — tracker audits, version bump, CHANGELOG curation, ROADMAP update, push, then watch the pipeline through to published artifacts.
---

# Release

Prepare a new warren release, push it, and verify the pipeline shipped it.
The release does not exist when the commit lands — it exists when the
Release workflow's five-job chain finishes: gates → tag → **draft** release
→ ghcr image + GKE deploy → npm publish → promote draft to final → Discord
announce. This command runs everything up to the push, then watches that
chain to the end.

## 1. Pre-flight

- Working tree is clean, on `main`, up to date with origin (`git status`,
  `git pull`).
- No open PRs about to auto-merge into the release commit:
  `gh pr list --state open`. If one is close to merging, either wait for it
  or release without it deliberately — never race it.
- Find the last release tag: `git describe --tags --abbrev=0`.

## 2. Tracker audits (two parallel subagents)

Spawn both subagents in a single message so they run concurrently. Neither
pushes — all commits ride out with the single push in step 9.

- **Seeds audit** — a subagent that invokes the `seeds-issue-audit` skill
  and follows it exactly: auto-close only HIGH-confidence issues with
  citable evidence, run `sd sync` after closing, report borderline cases,
  never push. Have it return its two tables (auto-closed / borderline).
- **GitHub issue sweep** — a subagent that lists open GitHub issues
  (`gh issue list --state open`) and verifies each against HEAD. Same
  discipline as the seeds audit: close an issue only when the fix is
  verifiably on `main` (name the commit or merged PR in the closing
  comment, `gh issue close <n> --comment "..."`); anything uncertain goes
  in a borderline table, untouched. Staleness alone never closes anything.

Hold both reports — the borderline tables go in the final summary (step
10), and confirmed-done plans feed the ROADMAP update (step 6).

## 3. Review changes since the last tag

- `git log <tag>..HEAD --oneline` and `git diff <tag>..HEAD --stat`.
- Determine the version bump level. **Always use patch unless the user
  explicitly requests minor or major.**

## 4. Bump the version

Run `bun run version:bump <major|minor|patch>`. It rewrites all four
version sites (`package.json`, `src/index.ts`, `docs/openapi.yaml` via
`gen:openapi`, and the README `## Status` line) and drafts an
`[Unreleased]` CHANGELOG block from the commit log.

## 5. Curate the CHANGELOG — this is a fatal release gate

Rework the drafted block by hand: regroup entries under `### Added` /
`### Changed` / `### Fixed`, rename the heading to
`## [X.Y.Z] - <today's date>`, and delete the
`<!-- version-bump:draft -->` markers.

The Release workflow **fails the release** if `CHANGELOG.md` has no
non-empty `## [X.Y.Z]` section — notes are never auto-generated. Write for
the reader of the GitHub release and the Discord announcement, not for the
git log.

## 6. Update ROADMAP.md

Reconcile the roadmap with what this release ships, following its own
rules (shipped items shrink to one table row; no design sketches):

- Move finished campaigns/plans out of **Now — in flight** into the
  **Shipped** table — one row, the new version number, a pointer to the
  design record. Use the seeds audit's confirmed-done plans as the input.
- Update the **Seam status** table for any seam this release changed.
- Re-order **Next** if the shipped work unblocked or promoted an item.

## 7. Doc pass

The gates already hold generated docs in place (`gen:docs:check`,
`gen:openapi:check`, `gen:cli-ref:check`, `check:agents`), so this pass is
prose only:

- `CLAUDE.md` (a symlink to `AGENTS.md`) if structure or command counts
  changed.
- `README.md` if the pitch, stats, or install instructions drifted.

## 8. Run the gates locally

```bash
bun run check:all
```

The Release workflow runs this same manifest first and a failure kills the
release with the version already bumped on `main`. Catch it here instead.

## 9. Commit and push

Commit the release changes (version sites, CHANGELOG, ROADMAP, docs). This
is the single push point: the tracker-audit commits from step 2 ride out
with it. Then `git push`. The push triggers the Release workflow (it fires
on `main` pushes touching `package.json` / `CHANGELOG.md`).

## 10. Watch the pipeline and verify

- Watch the Release workflow to completion:
  `gh run list --workflow=release.yml --limit 1`, then
  `gh run watch <run-id>`.
- Verify the release was **promoted out of draft**:
  `gh release view vX.Y.Z` shows it final and `--latest`. By the
  pipeline's ordering guarantee, a promoted release proves the ghcr image
  and the npm package already exist; spot-check npm anyway:
  `npm view @os-eco/warren-cli@X.Y.Z version`.
- If any job failed, say so plainly and stop — a draft release with no
  image is the designed failure state, not a partial success.

Finish with a summary: version, highlights, links (release URL, workflow
run), and the two borderline tables from step 2 for human review.
