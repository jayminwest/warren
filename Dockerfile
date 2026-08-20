# Warren container image (docs/design/runtime-and-supervisor.md).
#
# Two-stage build:
#   1. ui-builder — build the React/Vite SPA into src/ui/dist.
#   2. runtime    — bun + bwrap + uidmap, warren source, plus the bundled
#                   os-eco CLIs warren shells out to for opt-in features
#                   (mulch/seeds), and the SPA bundle copied from stage 1.
#
# The supervisor (src/supervisor/main.ts) is the ENTRYPOINT — it owns
# spawning + signal-forwarding for warren's HTTP server. See
# docs/design/runtime-and-supervisor.md for the contract.
#
# The four `bwrap` security flags (apparmor=unconfined, seccomp=unconfined,
# systempaths=unconfined, cap_add=SYS_ADMIN) are applied by the orchestrator
# (docker-compose.yml in the `local` topology), not the image. Under the
# `k8s` runtime there is no bwrap — the pod boundary is the sandbox. See
# docs/design/runtime-and-supervisor.md for the rationale.

# ---------- stage 1: build the UI ----------
#
# The build tree mirrors the repo's own layout — `ui/`, `core/`, and
# `client/` as siblings — because the SPA imports shared modules across
# those seams: `src/ui/src/api/types.ts` does
# `from "../../../core/wire.ts"` (warren-b229) and
# `src/ui/src/api/client.ts` does `from "../../../client/ndjson.ts"`
# (warren-53a7). `src/ui/tsconfig.app.json` lists each out-of-tree file
# in its `include`. A flat WORKDIR that copied only `src/ui` resolved
# those to a path outside the build context and failed the image build
# with TS2307, while `bun run build:ui` stayed green everywhere else
# because a full checkout has the files. Every out-of-tree entry in
# that `include` list needs a matching COPY below, or the image build
# breaks again.
FROM oven/bun:1.2 AS ui-builder
WORKDIR /build/ui
COPY src/core /build/core
COPY src/client/ndjson.ts src/client/errors.ts /build/client/
COPY src/ui/package.json src/ui/bun.lock src/ui/tsconfig.json ./
COPY src/ui/tsconfig.app.json src/ui/tsconfig.node.json ./
COPY src/ui/vite.config.ts src/ui/index.html ./
COPY src/ui/src ./src
RUN bun install --frozen-lockfile
RUN bun run build

# ---------- stage 2: runtime ----------
FROM oven/bun:1.2

# bubblewrap is the sandbox primitive warren's own sandbox uses
# (src/sandbox/, warren-5af7); uidmap provides newuidmap/newgidmap for the
# userns nesting. ca-certificates is needed by git over https. curl is kept
# around for first-run diagnostics.
#
# nodejs (real Node, not the bun-shim) is required by preview sidecars
# (warren-a82b): per-run JS dev servers (`pnpm dev`, `npm run dev`, `next`,
# `vite`, etc.) shell out through node_modules/.bin/* shell stubs whose
# shebang is `#!/usr/bin/env node`. Until this layer landed, that resolved
# to a bun-shim symlink installed below for pi compat, and Bun's built-in
# module coverage drift (e.g. missing `node:sqlite` on v1.2.23) crashed any
# Next.js / Remix project on startup. NodeSource ships a recent LTS — bookworm's
# stock `nodejs` package is too old (18.19) for current frontend stacks.
#
# netcat-openbsd is required by warren's inbound port-forwarder
# (src/sandbox/inbound-forward.ts): the forwarder accepts
# host-loopback connections and `nsenter`s into the sandbox netns to relay
# via `nc 127.0.0.1 <sandboxPort>`. Without it, every accepted connection's
# relay spawn fails, the host socket gets terminated, and any client (the
# warren readiness probe in particular) just sees connection drops until
# the deadline. Diagnosed against run_t688fe74n1ts (jayminwest.com) where
# `next dev -H 0.0.0.0` was finally binding on `0.0.0.0:3000` inside the
# netns but the 5m probe still failed because the relay never spawned.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        uidmap \
        git \
        ca-certificates \
        curl \
        gnupg \
        netcat-openbsd \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Bundled CLIs warren shells out to during run setup, reap, and project
# management. The two os-eco CLIs (seeds/mulch) back warren's opt-in
# features — they ship in every image so the features light up the moment
# a project or operator opts in, with no separate install. Versions track
# each tool's current release; bumping them is a deliberate image-rebuild
# decision.
#
# pnpm is baked in so per-run preview sidecars (R-19 / docs/design/preview-environments.md) can
# boot the common JS dev-server commands (`pnpm dev`) in projects that
# don't use bun. npm ships with the NodeSource `nodejs` package above,
# so we don't reinstall it via bun. Both run under the real Node installed
# in the apt layer (warren-a82b) — not the bun-shim — so any Node built-in
# module a project's deps reach for resolves correctly.
#
# BUN_INSTALL=/usr/local relocates the global package store from the default
# /root/.bun/install/global into /usr/local/install/global. The sandbox bwrap
# profile only ro-binds /usr, /etc, /lib, /lib64, /bin, /sbin, /opt — /root is
# not visible inside the sandbox, so symlinks at /usr/local/bin/{sd,ml}
# pointing into /root/.bun would dangle for the UID-1000 agent (warren-1eaa).
# /usr/local sits under /usr so the symlink targets resolve inside the sandbox.
ENV BUN_INSTALL=/usr/local
RUN bun install -g \
    @os-eco/seeds-cli@0.5.13 \
    @os-eco/mulch-cli@0.10.7 \
    @anthropic-ai/claude-code@2.1.150 \
    @earendil-works/pi-coding-agent@0.84.2 \
    pnpm@11.1.2

# bun install -g skips lifecycle scripts by default, so claude-code's
# postinstall (which downloads the platform-native `claude` binary) doesn't
# run. Invoke it explicitly so /usr/local/bin/claude is wired up before
# a run tries to spawn it.
RUN bun run /usr/local/install/global/node_modules/@anthropic-ai/claude-code/install.cjs

# Pi ships dist/cli.js with a `#!/usr/bin/env node` shebang. Historically we
# satisfied this by symlinking /usr/local/bin/node → the oven/bun-node-fallback
# shim, but that double-purposed the global `node` for non-pi consumers (npm
# stubs, dev-server shell-wrappers) which then loaded under Bun and crashed
# on Bun-missing built-ins like `node:sqlite` (warren-a82b). Now that real
# Node is installed in the apt layer above, /usr/local/bin/node IS real Node.
# Patch pi's shebang in-place so it runs under bun directly, bypassing the
# `node` binary entirely. Without this pi would launch under real Node — which
# pi does not target — and break on the first bun-only API it touches.
RUN sed -i '1s|^#!/usr/bin/env node|#!/usr/bin/env bun|' \
        /usr/local/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js

WORKDIR /app

# Server-side dependencies. Copy lockfiles first so a code-only edit
# doesn't bust the bun install layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Source. Excludes are listed in .dockerignore (node_modules, data, .env,
# src/ui/node_modules, src/ui/dist) so we don't ship dev artefacts.
COPY . /app

# Pull the prebuilt UI bundle from stage 1.
COPY --from=ui-builder /build/ui/dist /app/src/ui/dist

# Put warren itself on PATH. package.json declares bin: { warren, wr } but
# `bun install -g` is not run for /app, so the bin entries aren't wired up.
# Symlink the entrypoint directly — main.ts is +x with a `#!/usr/bin/env bun`
# shebang, so it runs as-is once on PATH.
RUN ln -s /app/src/cli/main.ts /usr/local/bin/warren \
 && ln -s /app/src/cli/main.ts /usr/local/bin/wr

# Default data root — the deploy mounts a persistent volume here.
ENV WARREN_DATA_DIR=/data

# /data is a persistence boundary (sqlite + cloned project repos + the
# local backend's run state).
RUN mkdir -p /data

EXPOSE 8080

ENTRYPOINT ["bun", "run", "src/supervisor/main.ts"]
