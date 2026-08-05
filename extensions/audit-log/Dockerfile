# syntax=docker/dockerfile:1
# @warren-ext/audit-log — the flagship warren observer extension (plan pl-116e,
# step 5, warren-88b8).
#
# This image builds from THIS DIRECTORY ALONE (docs/design/extensions.md §2):
#   docker build -t warren-ext-audit-log .
# Nothing outside extensions/audit-log/ is referenced — the build context is the
# package, exactly as a third party would ship theirs.
#
# Run against a warren instance given only the two required variables:
#   docker run --rm -p 8080:8080 -v audit-log-data:/app/data \
#     -e WARREN_BASE_URL=https://warren.example.com \
#     -e WARREN_API_TOKEN=... \
#     warren-ext-audit-log

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

# The extension owns its storage (extensions.md §3): the SQLite store lives on
# a volume at /app/data, never in a warren table. The oven/bun images ship a
# non-root `bun` user; hand it the data dir and drop root.
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun

# In-image defaults so the container runs given ONLY WARREN_BASE_URL and
# WARREN_API_TOKEN. Every knob stays overridable at run time.
ENV AUDIT_LOG_DB_PATH=/app/data/audit-log.db \
    AUDIT_LOG_LISTEN_PORT=8080

EXPOSE 8080

# Warren has no healthcheck/readiness convention an orchestrator can discover
# (FRICTION.md §4), so the image declares its own probe against /healthz.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD bun -e "fetch('http://127.0.0.1:'+(process.env.AUDIT_LOG_LISTEN_PORT??'8080')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
