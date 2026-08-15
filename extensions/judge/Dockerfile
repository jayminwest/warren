# syntax=docker/dockerfile:1
# @warren-ext/judge — warren's second observer extension (plan pl-17ca):
# a bounded, read-only LLM judge loop emitting rubric-v1 verdicts
# (docs/design/agent-analytics.md §12).
#
# This image builds from THIS DIRECTORY ALONE (docs/design/extensions.md §2):
#   docker build -t warren-ext-judge .
# Nothing outside extensions/judge/ is referenced — the build context is the
# package, exactly as a third party would ship theirs.
#
# Run against a warren instance given the two required variables plus the
# configured provider's model credential:
#   docker run --rm -v judge-data:/app/data \
#     -e WARREN_BASE_URL=https://warren.example.com \
#     -e WARREN_API_TOKEN=... \
#     -e ANTHROPIC_API_KEY=... \
#     warren-ext-judge

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

# The extension owns its storage (extensions.md §3): verdicts and the poll
# cursor live on a volume at /app/data, never in a warren table. The oven/bun
# images ship a non-root `bun` user; hand it the data dir and drop root.
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun

# In-image defaults so the container runs given only the required variables.
# Every knob stays overridable at run time.
ENV JUDGE_DB_PATH=/app/data/judge.db

# The judge serves no HTTP surface yet, so there is no HEALTHCHECK. Liveness
# is the process itself; a later step adds a probe when the loop lands.

CMD ["bun", "run", "src/index.ts"]
