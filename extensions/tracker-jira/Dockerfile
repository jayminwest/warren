# syntax=docker/dockerfile:1
# @warren-ext/tracker-jira - warren-tracker/v1 over the Jira Cloud REST
# API (warren-27d9).
#
# This image builds from THIS DIRECTORY ALONE (docs/design/extensions.md §2):
#   docker build -t warren-ext-tracker-jira .
#
# It needs a Jira site, a credential and a query. Nothing is baked in:
#   docker run --rm -p 8080:8080 \
#     -e JIRA_BASE_URL=https://acme.atlassian.net \
#     -e JIRA_EMAIL=bot@acme.example \
#     -e JIRA_API_TOKEN=... \
#     -e JIRA_JQL='project = WAR AND labels = warren' \
#     warren-ext-tracker-jira
#
# The Jira credential arrives at runtime and is never written to disk or
# logged. Pass it as a secret in any orchestrator that has one.

# ---- deps stage: resolve node_modules from the package's OWN lockfile ----
FROM oven/bun:1.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime stage ----
FROM oven/bun:1.2-slim
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER bun

ENV TRACKER_PORT=8080

EXPOSE 8080

# /capabilities is answered locally, so the probe reports whether this
# container is up without spending a Jira call every 30 seconds. It
# carries TRACKER_BEARER when one is set, or a protected container would
# answer its own healthcheck with a 401.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD bun -e "const t=process.env.TRACKER_BEARER;fetch('http://127.0.0.1:'+(process.env.TRACKER_PORT??'8080')+'/capabilities',{headers:t?{authorization:'Bearer '+t}:{}}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
