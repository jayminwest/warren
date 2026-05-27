# Dev Container

Bun-based dev container for warren. Open the repo in VS Code with the
[Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
(or in a GitHub Codespace) and select **"Reopen in Container"**.

## What you get

- Ubuntu 22.04 base
- Bun (latest) — runs the warren server and all scripts
- `git` + `gh` (GitHub CLI)
- VS Code extensions: Biome, Bun, Tailwind CSS IntelliSense
- Forwarded ports: `3000` (warren server) and `5173` (Vite UI dev server)

`postCreateCommand` installs root deps and `src/ui/` deps automatically.

## Verifying

After the container builds:

```bash
bun test && bun run lint && bun run typecheck
```

These are the same quality gates CI runs (see `AGENTS.md`).

## Notes

- The container is intended for local development; warren's production
  runtime is the burrow-co-tenanted image (`docker-compose.yml`), not
  this devcontainer.
- Tabs, width 2 — matches Biome config.
