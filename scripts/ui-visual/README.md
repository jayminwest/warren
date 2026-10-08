# ui-visual

Rendered-output checks for the web UI (plan pl-10db). The harness boots warren
against a seeded, clock-frozen fixture, opens every screen in Chromium, and
asserts on what actually rendered.

## Run it

```bash
bunx playwright install chromium   # once per machine
bun run check:ui-visual --build    # builds src/ui, boots the fixture, runs the specs
```

Without `--build`, the built SPA in `src/ui/dist/` must already exist
(`bun run build:ui`). Every other argument goes to `playwright test`:

```bash
bun run check:ui-visual --grep run-detail     # one page
bun run check:ui-visual --headed --workers 1  # watch it
```

Narrow the matrix with comma lists in `WARREN_UI_VISUAL_PAGES`,
`WARREN_UI_VISUAL_VIEWPORTS`, and `WARREN_UI_VISUAL_THEMES`. An unknown name
is an error, not an empty run. `WARREN_UI_VISUAL_WORKERS` overrides the
worker count (4 locally, 2 under `CI`).

Output lands in `scripts/ui-visual/out/`, which git ignores. Screenshots go to
`out/screenshots/<page>.<viewport>.<theme>.png`, the HTML report to
`out/report/`, and failure traces to `out/test-results/`.

`check:ui-visual` is not part of `check:all`, because the gate manifest is
frozen. CI runs it from its own workflow.

## CI

`.github/workflows/ui-visual.yml` runs the harness on every PR and main push
that touches `src/ui/`, this directory, the SPA server, or the dependency
manifests. It reports a status check named `ui-visual`. The job runs inside
the official `mcr.microsoft.com/playwright` image, pinned by tag and digest
to the `@playwright/test` version in `package.json`, so fonts and
rasterization match from run to run. `ci-workflow.test.ts` fails when the
image tag and the devDependency drift apart; bump both together and refresh
the digest (the workflow header shows how).

Each run uploads `out/` as the artifact `ui-screenshots-<head sha>`, kept for
14 days, pass or fail. It also writes `out/ci-meta.json` with the PR number,
head sha, and outcome for follow-up workflows.

## What the smoke spec asserts

`smoke.pw.ts` runs every page at desktop (1440x900) and phone (393x852) in the
light and dark themes. Each case must pass four checks:

- **console**: no `console.error` and no uncaught page error. Chromium logs
  failed resource loads (4xx/5xx) here too.
- **overflow**: no horizontal overflow in the document or in the shell's
  scrolling `<main>`.
- **root**: `#root` rendered children.
- **text**: the body text contains no `undefined`, `NaN`, or
  `[object Object]`.

Before the checks run, each case pins the browser clock to the fixture's frozen
time, seeds `warren.theme` and the operator token into localStorage, and waits
until the page goes quiet. Quiet means no request in flight (event streams
aside), no spinner, and web fonts loaded. Timezone and locale are pinned to
UTC and en-US.

## Add a page

Add a `PageSpec` to `PAGES` in `pages.ts`. Give it a kebab-case `id`, the
`app.tsx` route it renders, and a `path` built from the fixture ids
(`fixture-boot.ts` documents them). `pages.test.ts` fails when `app.tsx` gains
a screen route with no manifest entry. It also fails on an entry whose route
no longer exists.

Mark a wall-clock value in the UI with a `data-visual-mask` attribute so
screenshots blank it. Use the per-page `mask` selectors only when the markup
cannot carry the attribute.

## Known failures

`KNOWN_FAILURES` in `smoke-checks.ts` lists the smoke failures the harness
tolerates. Each entry names its page, check, a `match` pattern, and the seed
that fixes it. A listed failure that stops reproducing fails the run, so
delete its entry in the PR that fixes it.

## Layout

- `pages.ts`: the page manifest, viewports, themes, and case expansion.
- `smoke-checks.ts`: the pure smoke checks and the known-failure list.
- `harness.ts`: browser helpers every spec shares (`openCase`,
  `screenshotCase`, `observe`).
- `fixture-env.ts`: parses the fixture hand-off from `run.ts`.
- `run.ts`: the `check:ui-visual` entry point.
- `playwright.config.ts`: Chromium only. `snapshotPathTemplate` points at
  `__golden__/`.
- `fixture-*.ts`: the deterministic fixture boot (warren-010b).

Specs are named `*.pw.ts`, not `*.spec.ts`, because `bun test` discovers
`.spec.` files. Playwright runs under Node through `bunx playwright test`,
never `bun --bun` (oven-sh/bun#8222).
