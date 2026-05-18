# Warren container image (SPEC §10.3).
#
# Two-stage build:
#   1. ui-builder — build the React/Vite SPA into src/ui/dist.
#   2. runtime    — bun + bwrap + uidmap, warren source, burrow itself
#                   plus the bundled os-eco CLIs warren shells out to for
#                   opt-in features (canopy/mulch/seeds/sapling), and the
#                   SPA bundle copied from stage 1.
#
# The supervisor (src/supervisor/main.ts) is the ENTRYPOINT — it owns
# spawning + signal-forwarding + restart policy for `burrow serve` and
# warren's HTTP server. See SPEC §10.3 for the contract.
#
# The four `bwrap` security flags (apparmor=unconfined, seccomp=unconfined,
# systempaths=unconfined, cap_add=SYS_ADMIN) are applied by the orchestrator
# (docker-compose.yml or fly.toml), not the image. See SPEC §5.3 + §11.A
# and burrow's DEPLOY.md for the rationale.

# ---------- stage 1: build the UI ----------
FROM oven/bun:1.2 AS ui-builder
WORKDIR /ui-build
COPY src/ui/package.json src/ui/bun.lock src/ui/tsconfig.json ./
COPY src/ui/tsconfig.app.json src/ui/tsconfig.node.json ./
COPY src/ui/vite.config.ts src/ui/index.html ./
COPY src/ui/src ./src
RUN bun install --frozen-lockfile
RUN bun run build

# ---------- stage 2: runtime ----------
FROM oven/bun:1.2

# bubblewrap is the sandbox primitive burrow uses (see burrow DEPLOY.md);
# uidmap provides newuidmap/newgidmap for the userns nesting. ca-certificates
# is needed by git over https. curl is kept around for first-run diagnostics
# against the burrow socket (saves having to bun -e fetch() workarounds).
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
# netcat-openbsd is required by burrow's inbound port-forwarder (SPEC §8.7,
# `../burrow/src/provider/local/inbound-forward.ts`): the forwarder accepts
# host-loopback connections and `nsenter`s into the burrow netns to relay
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
# management, plus burrow itself (the supervisor execs `burrow serve`).
# The four os-eco CLIs (canopy/seeds/mulch/sapling) back warren's opt-in
# features — they ship in every image so the features light up the moment
# a project or operator opts in, with no separate install. Versions track
# each tool's current release; bumping them is a deliberate image-rebuild
# decision.
#
# pnpm is baked in so per-run preview sidecars (R-19 / SPEC §11.L) can
# boot the common JS dev-server commands (`pnpm dev`) in projects that
# don't use bun. npm ships with the NodeSource `nodejs` package above,
# so we don't reinstall it via bun. Both run under the real Node installed
# in the apt layer (warren-a82b) — not the bun-shim — so any Node built-in
# module a project's deps reach for resolves correctly.
#
# BUN_INSTALL=/usr/local relocates the global package store from the default
# /root/.bun/install/global into /usr/local/install/global. Burrow's bwrap
# profile only ro-binds /usr, /etc, /lib, /lib64, /bin, /sbin, /opt (see
# burrow src/provider/local/bwrap.ts SYSTEM_RO_MOUNTS) — /root is not visible
# inside the sandbox, so symlinks at /usr/local/bin/{sd,ml,cn,sapling,burrow}
# pointing into /root/.bun would dangle for the UID-1000 agent (warren-1eaa).
# /usr/local sits under /usr so the symlink targets resolve inside the sandbox.
ENV BUN_INSTALL=/usr/local
RUN bun install -g \
    @os-eco/burrow-cli@0.3.2 \
    @os-eco/canopy-cli@0.2.4 \
    @os-eco/seeds-cli@0.4.3 \
    @os-eco/mulch-cli@0.9.0 \
    @os-eco/sapling-cli@0.3.2 \
    @os-eco/plot-cli@0.3.0 \
    @anthropic-ai/claude-code@2.1.138 \
    @earendil-works/pi-coding-agent@0.74.0 \
    pnpm@11.1.2

# bun install -g skips lifecycle scripts by default, so claude-code's
# postinstall (which downloads the platform-native `claude` binary) doesn't
# run. Invoke it explicitly so /usr/local/bin/claude is wired up before
# burrow tries to spawn it.
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
COPY --from=ui-builder /ui-build/dist /app/src/ui/dist

# Put warren itself on PATH. package.json declares bin: { warren, wr } but
# `bun install -g` is not run for /app, so the bin entries aren't wired up.
# Symlink the entrypoint directly — main.ts is +x with a `#!/usr/bin/env bun`
# shebang, so it runs as-is once on PATH.
RUN ln -s /app/src/cli/main.ts /usr/local/bin/warren \
 && ln -s /app/src/cli/main.ts /usr/local/bin/wr

# Default data root — the deploy mounts a persistent volume here.
ENV WARREN_DATA_DIR=/data
ENV WARREN_BURROW_SOCKET=/var/run/burrow.sock

# Pin burrow's data dir onto the same persistent volume warren uses.
# Burrow's default is XDG_DATA_HOME/burrow (~/.local/share/burrow on the
# container's writable overlay), which gets wiped on every redeploy and
# orphans any in-flight runs whose warren-side state still says 'running'
# but whose burrow-side execution state was the freshly-erased SQLite
# (warren-0375). BURROW_DATA_DIR is read by burrow's path resolver
# (node_modules/@os-eco/burrow-cli/src/config/paths.ts) ahead of
# XDG_DATA_HOME and lands db.sqlite, archive/, projects/ under /data.
# The supervisor's burrow child inherits this env (src/supervisor/main.ts).
ENV BURROW_DATA_DIR=/data/burrow

# /data is a persistence boundary (sqlite + cloned canopy + cloned project
# repos + burrow's db.sqlite under /data/burrow). /var/run is where the
# supervisor binds burrow's unix socket; the directory must exist for
# `burrow serve --socket /var/run/burrow.sock`. /data/burrow itself is
# created by burrow's db client (mkdir -p of dbPath's dirname) on first
# open — it doesn't need pre-creation here (it'd be shadowed by the
# volume mount anyway).
RUN mkdir -p /data /var/run

EXPOSE 8080

ENTRYPOINT ["bun", "run", "src/supervisor/main.ts"]
