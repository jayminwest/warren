---
name: release
---

## body

Analyze all changes since the last release and prepare a new version.

Steps:

1. Find the last release tag: `git describe --tags --abbrev=0 2>/dev/null || echo "none"`
2. If there's a previous tag, review changes: `git log <tag>..HEAD --oneline` and `git diff <tag>..HEAD`
3. Determine the version bump level. **Always use patch unless the user explicitly requests minor or major.**
4. Run `bun run version:bump <major|minor|patch>`. It rewrites all four version sites (`package.json`, `src/index.ts`, `docs/openapi.yaml` via `gen:openapi`, and the README `## Status` line) and drafts an `[Unreleased]` CHANGELOG block from the commit log. The release workflow (`.github/workflows/release.yml`) fails if `package.json` and `src/index.ts` disagree.
5. Curate the drafted `CHANGELOG.md` block by hand — regroup the entries under `### Added` / `### Changed` / `### Fixed`, rename the heading to the new version with today's date, and delete the `<!-- version-bump:draft -->` markers
6. Update `CLAUDE.md` if command counts or structure changed
7. Update `README.md` if CLI reference or stats changed
8. COMMIT YOUR CHANGES! Then present a summary of all changes made.
