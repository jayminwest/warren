# Contributing to Warren

Thanks for your interest in contributing to Warren! This guide covers everything you need to get started. [`docs/README.md`](docs/README.md) indexes every other operator and contributor document.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/warren.git
   cd warren
   ```
3. **Install** dependencies:
   ```bash
   bun install
   ```
4. **Run** the CLI straight from the checkout:
   ```bash
   bun run src/cli/main.ts --help
   ```
   Since v0.14.0 the CLI also ships on npm, so end users can `npm i -g @os-eco/warren-cli` instead.
5. **Create a branch** for your work:
   ```bash
   git checkout -b fix/description-of-change
   ```

## Branch Naming

Use descriptive branch names with a category prefix:

- `fix/` -- Bug fixes
- `feat/` -- New features
- `docs/` -- Documentation changes
- `refactor/` -- Code refactoring
- `test/` -- Test additions or fixes

## Build & Test Commands

```bash
bun test                                   # Run all tests
bun test src/foo.test.ts                   # Run a single test file
bun run check:all                          # All quality gates CI enforces
```

Run lint, typecheck, and the other gates through `bun run check:all`. `biome check .` alone is not the gate. Always run `bun run check:all` before submitting a PR.

## Development Loop

The day-to-day loop from a fresh checkout:

1. `git clone` your fork and `bun install`
2. Make your change, then `bun test` — or `bun test src/foo.test.ts` for a single file
3. For UI work (`src/ui/`), run `bun run build:ui` to typecheck and rebuild the Vite bundle. The root typecheck skips it
4. `bun run check:all` before pushing — it must exit zero

See `AGENTS.md` for the full gate manifest and repo conventions.

## TypeScript Conventions

Warren is a strict TypeScript project that runs directly on Bun (no build step).

### Strict Mode

- `noUncheckedIndexedAccess` is enabled -- always handle possible `undefined` from indexing
- No `any` -- use `unknown` and narrow, or define proper types

### Dependencies

- Minimal runtime deps: only what's truly needed
- Use Bun built-in APIs where possible: `bun:sqlite` for persistence, `Bun.spawn` for subprocesses, `Bun.file` / `Bun.write` for file I/O, `Bun.serve` for HTTP

### Formatting

- **Tab indentation** (enforced by Biome)
- **100 character line width** (enforced by Biome)
- Biome handles import organization automatically

### File Organization

- Types live with the domain that owns them: `src/core/` for ids and the error hierarchy, `src/server/types.ts` for the HTTP wire shapes, and `src/runs/`, `src/projects/`, `src/registry/` for their own
- Enum-shaped wire values live once in `src/core/wire.ts`. Every other surface re-exports them (see `AGENTS.md` for the full rule)
- Each CLI command gets its own file in `src/cli/commands/`
- Import with `.ts` extensions

## Testing Conventions

- **No mocks for storage or filesystem.** Tests use real filesystems and real SQLite.
- Create temp directories with `mkdtemp` for file I/O tests
- Use `:memory:` or temp file databases for SQLite tests
- External boundaries (burrow HTTP API, agent runtimes) may be stubbed at the boundary, but the layers above must run real code paths
- Clean up in `afterEach`
- Tests are colocated with source files: `src/foo.test.ts` alongside `src/foo.ts`

Example test structure:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it, expect } from "bun:test";

describe("my-feature", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "warren-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  it("does the thing", async () => {
    // Write real files, run real code, assert real results
  });
});
```

## Adding a New Command

1. Create `src/cli/commands/<name>.ts`, exporting a pure `run<Name>` function
2. Import it in `src/cli/main.ts` and add its `case` to the subcommand dispatch
3. Add tests in `src/cli/commands/<name>.test.ts`
4. Add a row to the `## CLI` table in `README.md`

## Commit Message Style

Use concise, descriptive commit messages:

```
fix: close stream on client disconnect
feat: add scheduled run support
docs: document warren.toml schema
```

Prefix with `fix:`, `feat:`, or `docs:` when the category is clear. Plain descriptive messages are also fine.

## Pull Request Expectations

- **One concern per PR.** Keep changes focused -- a bug fix, a feature, a refactor. Not all three.
- **Tests required.** New features and bug fixes should include tests. See the testing conventions above.
- **Passing CI.** All PRs must pass the full `bun run check:all` gate manifest before merge.
- **Description.** Briefly explain what the PR does and why. Link to any relevant issues.

## Finding Work

New to the project? Filter the [GitHub issue tracker](https://github.com/jayminwest/warren/issues) by the `good first issue` label for scoped, newcomer-friendly tasks.

## Reporting Issues

Use [GitHub Issues](https://github.com/jayminwest/warren/issues) for bug reports and feature requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

Issue templates apply the baseline `type/*`, `priority/*`, and
`status/needs-triage` labels automatically. The full label taxonomy --
namespaced `priority/*`, `type/*`, `area/*`, `status/*`, and `effort/*`
groups -- is documented in [`docs/labels.md`](docs/labels.md) and
defined canonically in [`.github/labels.yml`](.github/labels.yml). The
[`sync-labels`](.github/workflows/sync-labels.yml) workflow keeps the
GitHub repository's labels in sync with the source file.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
