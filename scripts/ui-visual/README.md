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

## What the a11y spec asserts

`a11y.pw.ts` (warren-b629) opens the same cases through `openCase` and runs
axe-core (`@axe-core/playwright`) with the `wcag2a` and `wcag2aa` tags. Any
violation with impact `serious` or `critical` fails the case. The failure
message lists the rule id, impact, help URL, and up to eight node selectors.

`a11y-allowlist.json` grandfathers today's violations. Each entry names its
page, the axe rule id, an optional `viewport` or `theme`, and the seed that
fixes it. A listed violation that stops reproducing fails the run, so delete
its entry in the PR that fixes it. `a11y-checks.test.ts` also holds the entry
count to a ceiling that only goes down.

Filtering, allowlist matching, and the report format live in
`a11y-checks.ts` and run under `bun test` with no browser.

## Golden screenshots

`golden.pw.ts` compares each page against a committed baseline in
`__golden__/<page>-<viewport>-<theme>.png` with `toHaveScreenshot` (full page,
animations off, masks applied, up to 1% of pixels may differ). Phone x dark has
no golden: desktop x dark pins the dark palette, phone x light pins the phone
layout, and the smaller set stays well under the 8 MB budget. Smoke and a11y
still cover every pair.

Fonts and rasterization differ between hosts, so the golden spec runs only in
the ui-visual workflow's pinned Playwright container: linux/x64 with
`WARREN_UI_VISUAL_GOLDEN=1`, which only the workflow sets. Anywhere else
`check:ui-visual` prints why it skipped `golden.pw.ts` and runs the smoke spec
as usual. A missing baseline fails the comparison
(`updateSnapshots: "none"`); Playwright never writes one silently.

On a mismatch the spec copies Playwright's images to a fixed layout inside the
`ui-screenshots-<sha>` artifact:

```
out/golden-diff/<page>.<viewport>.<theme>/expected.png
out/golden-diff/<page>.<viewport>.<theme>/actual.png
out/golden-diff/<page>.<viewport>.<theme>/diff.png
out/golden-diff/<page>.<viewport>.<theme>/result.json
```

`result.json` names the case, page, viewport, theme, URL, golden path, and the
error text.

### Regenerate the baselines

Never generate baselines on a laptop. Dispatch the workflow on your pushed
branch, then commit what it uploads:

```bash
gh workflow run ui-visual.yml --ref <branch> -f update_goldens=true
gh run list --workflow ui-visual.yml --branch <branch> --limit 1   # find the run id
gh run download <run id> -n ui-goldens-<head sha> -D scripts/ui-visual/__golden__
git add scripts/ui-visual/__golden__
```

The dispatch deletes the old PNGs, renders the whole set with
`--update-snapshots=all`, and writes `__golden__/manifest.json`: the Playwright
version, the image and digest, the commit it rendered, the run URL, and the
sha256, size, and dimensions of every PNG.

### Approve the baselines

A PR that changes `__golden__/`, or the files that decide how a render
compares (`golden-cases.ts`, `golden.pw.ts`, `golden-manifest.ts`,
`goldens.ts`, `playwright.config.ts`, and `ui-visual.yml`), never auto-merges
on its own. A human approver reviews the new baselines and applies the
`ui-baseline-approved` label:

1. Read the diff: GitHub's rich diff of each PNG, the `golden-diff/` images in
   the `ui-screenshots-<sha>` artifact, and the PR comment crops once
   warren-70d9 lands.
2. Apply `ui-baseline-approved`. The label event re-runs `auto-merge.yml`,
   which checks the approval and arms auto-merge.
3. If a later push changes the baselines again, the workflow refuses and
   disarms. Review again, then remove and re-apply the label.

The `UI baseline approval check` step in `.github/workflows/auto-merge.yml`
runs `baseline-approval.ts` from the base branch. It reads the labeler from
the issue events API, so a label that a bot applies never counts. It reads the
head the approver saw from the repository activity API, and it refuses when
the baselines differ from that head. Approvers are the repository variable
`UI_BASELINE_APPROVERS`, or the repository owner when it is unset. The policy,
the threat model, and the fail-closed rules are in
[docs/design/ui-visual-gate.md](../../docs/design/ui-visual-gate.md).

A change to `baseline-approval.ts` itself always needs a human merge.

### The guard

`bun run check:ui-goldens` (`goldens.ts check`, rules in `golden-manifest.ts`)
runs in the workflow before every comparison. It fails when:

- a PNG's sha256 is not the one `manifest.json` records (a laptop render), or
  a PNG is missing from it
- the manifest names another Playwright version or container image than
  `package.json` and the workflow pin (regenerate after a bump)
- a page manifest case has no baseline, or a baseline has no case
- the set is over 8 MB, or a stray file sits in `__golden__/`

### Masks

Mark anything that changes per release, per host, or per wall-clock second
with `data-visual-mask`: the version string, uptime, and the project's local
clone path carry it today. A mask paints a solid box over the element, so
give the element a stable box (a full-width row or field) where you can.

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
- `a11y-checks.ts`: the pure axe filtering and allowlist reconciliation;
  `a11y-allowlist.json` holds the grandfathered violations.
- `harness.ts`: browser helpers every spec shares (`openCase`,
  `atContentHeight`, `screenshotCase`, `observe`).
- `golden.pw.ts`: the golden comparison. `golden-cases.ts` holds the golden
  matrix and the container gate. `golden-manifest.ts` and `goldens.ts` hold
  the generator manifest and its guard.
- `baseline-approval.ts`: the auto-merge gate for baseline changes. It imports only
  `node:` modules, because `auto-merge.yml` runs the base branch's copy alone.
- `__golden__/`: the committed baselines and `manifest.json`. CI writes them,
  never a laptop.
- `fixture-env.ts`: parses the fixture hand-off from `run.ts`.
- `run.ts`: the `check:ui-visual` entry point.
- `playwright.config.ts`: Chromium only. `snapshotPathTemplate` points at
  `__golden__/`.
- `fixture-*.ts`: the deterministic fixture boot (warren-010b).

Specs are named `*.pw.ts`, not `*.spec.ts`, because `bun test` discovers
`.spec.` files. Playwright runs under Node through `bunx playwright test`,
never `bun --bun` (oven-sh/bun#8222).
