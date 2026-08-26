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
# The V0 runtime contract (dry-run only; there is no live mode):
#   docker run --rm -v campaign-data:/app/data \
#     -e WARREN_BASE_URL=https://warren.example.com \
#     -e WARREN_API_TOKEN=... \
#     -e CAMPAIGN_POLICY_PATH=/app/data/policy.json \
#     warren-ext-campaign-controller manifest import --manifest /app/data/manifest.json --policy /app/data/policy.json
#   docker run --rm ... warren-ext-campaign-controller tick --campaign <id>

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

# Entrypoint: the operator CLI. NDJSON on stdout is the machine contract;
# exit codes follow the table in src/cli/exit-codes.ts. Secrets enter only
# through the WARREN_API_TOKEN and GITHUB_TOKEN environment variables.
CMD ["bun", "run", "src/cli/main.ts"]
