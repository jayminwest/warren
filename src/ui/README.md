# warren ui

React + Vite + Tailwind v4 + shadcn-style components. Built into `dist/`
and served by warren's HTTP server (`src/server/ui.ts`).

## Develop

```bash
# from src/ui/
bun install
bun run dev          # http://localhost:5173 — proxies API to :8080
```

In another terminal, boot warren in dev mode (e.g. `bun src/server/main/index.ts`)
on port 8080 so the proxy has a backend to hit.

## Build

```bash
# from src/ui/
bun install
bun run build        # → src/ui/dist/

# or from the repo root:
bun run build:ui
```

The Bun supervisor (`src/supervisor/main.ts`, Phase 12) and the warren
server (`src/server/main/index.ts`) both expect `dist/index.html` to exist when
`WARREN_UI_DIST` is set; the static UI handler (`src/server/ui.ts`)
serves any file under `dist/` and falls through to `index.html` for
deep-link SPA routes.

## Responsive contract

The UI is **mobile-first**. Unprefixed (base) utility classes target the
phone range; Tailwind's first breakpoint `sm:` (640px) is the cutover to
the desktop/compact layout. The canonical targets and reusable pattern
tokens live in one place — `src/components/ui/responsive.ts` — so every
surface degrades the same way:

- **393px (`PHONE_MAX`)** — primary phone target (iPhone logical width).
  Everything must look intentional here.
- **360px (`PHONE_MIN`)** — smallest supported width; layouts must stay
  usable with no horizontal overflow that hides data.
- **640px (`SM_BREAKPOINT`)** — Tailwind's first breakpoint and our
  mobile→desktop cutover.

`responsive.ts` exports the standardized class-name tokens that pages
should reuse instead of re-typing ad-hoc strings:

- `responsiveTable.cellNoWrap` / `cellTruncate` — the wide-table-on-mobile
  pattern. The `Table` primitive already wraps the `<table>` in
  `overflow-auto`, so a too-wide table scrolls horizontally inside its
  card; `cellNoWrap` keeps every cell on one line for a clean scroll, and
  `cellTruncate` caps + ellipsizes wide free-text columns (ids, messages).
- `responsiveCardHeaderRow` — card headers whose title/stat pairs with
  action controls; wraps the controls to a second row on narrow widths.
- `responsiveTrailingControl` — an `ml-auto`-pushed filter control that
  becomes a full-width row on mobile and floats back at `sm+`.
- `responsiveFormControl` — 44px touch targets + 16px text on phones
  (the 16px floor suppresses iOS Safari focus auto-zoom), compact at `sm+`.
- `responsiveFooterActions` / `responsiveFooterButton` — footer action
  rows that stack full-width on mobile and right-align at `sm+`.

## Visual language

The console keeps the Direction C operator look: blue-gray surfaces,
hairline borders, and one green action per view. The type scale is
readable (warren-468e). Follow these rules.


- **Type.** Use only the scale utilities. `text-2xs` is 11px, the floor. `text-xs` is 12px and `text-sm` is 13px, the body size. `text-base` is 14px, `text-lg` 17px, `text-xl` 20px for page titles, and `text-2xl` 24px for stat numbers. Each step sets its own line height. Do not add a `leading-*` literal or a `text-[Npx]` literal.

- **Case.** Use sentence case for labels, table headers, buttons, and status. Do not use uppercase letter-spaced labels.

- **Mono.** Use `font-mono` only for machine identifiers: run ids, seed ids, branches, hashes, file paths, and log lines. Numbers use the sans face with `tabular-nums`. Names, agents, projects, and times use sans.

- **Colour.** Colour shows meaning and nothing else. Status comes from `components/ui/status.tsx`. Do not write a local state-to-colour map.

- **Surfaces.** Panels use `Card`, `CardHeader`, `CardBody`, and `CardFooter`, and size to their content. Pages open with `PageHeader`. Tables use `components/ui/table.tsx`. Neutral labels use `Tag`.

- **States.** Show loading with `SkeletonRows` or `Skeleton` in the shape of the content. Show an empty list with `EmptyState`. Say what fills the list and, for an operator, give the action. An error names what failed and how to retry.

- **Forms.** Use `Input`, `Select`, `Textarea`, `Button`, and `Segmented`. Do not use raw form elements or local class strings.

- **Copy.** Write for the operator. Visible text has no issue ids, API names, poll intervals, or notes about missing APIs.
