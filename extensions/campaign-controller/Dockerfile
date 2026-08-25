# syntax=docker/dockerfile:1
# @warren-ext/campaign-controller — the first warren *controller* extension
# (plan pl-91b6, OpenClaw V0): a dry-run-only upstream-contribution campaign
# controller.
#
# This image builds from THIS DIRECTORY ALONE (docs/design/extensions.md §2):
#   docker build -t warren-ext-campaign-controller .
# Nothing outside extensions/campaign-controller/ is referenced — the build
# context is the package, exactly as a third party would ship theirs.
#
# The V0 runtime contract (not yet implemented — scaffold only):
#   docker run --rm -v campaign-data:/app/data \
#     -e WARREN_BASE_URL=https://warren.example.com \
#     -e WARREN_API_TOKEN=... \
#     warren-ext-campaign-controller

# ---- deps stage: resolve node_modules from the package's OWN lockfile ----
FROM oven/bun:1.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# The package has no runtime dependencies today; --production keeps the stage
# honest if one is added, and --frozen-lockfile makes the build reproducible.
RUN bun install --frozen-lockfile --production

# ---- runtime stage ----
FROM oven/bun:1.2-slim
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# The extension owns its storage (extensions.md §3): the campaign state store
# and action journal live on a volume at /app/data, never in a warren table.
# The oven/bun images ship a non-root `bun` user; hand it the data dir and
# drop root.
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun

ENV CAMPAIGN_DB_PATH=/app/data/campaign.db

# Entrypoint placeholder: exits non-zero with `not_implemented` until the
# pl-91b6 steps land. The build reaching this CMD is the scaffold contract.
CMD ["bun", "run", "src/index.ts"]
