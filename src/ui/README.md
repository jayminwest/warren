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
