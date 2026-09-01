# syntax=docker/dockerfile:1
# @warren-ext/tracker-ado - warren-tracker/v1 over the Azure DevOps Boards
# REST API.
#
# This image builds from THIS DIRECTORY ALONE (docs/design/extensions.md §2):
#   docker build -t warren-ext-tracker-ado .
#
# It needs an organization, a project, a credential and a query. Nothing
# is baked in:
#   docker run --rm -p 8080:8080 \
#     -e ADO_ORG_URL=https://dev.azure.com/acme \
#     -e ADO_PROJECT=Platform \
#     -e ADO_PAT=... \
#     -e ADO_WIQL="SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS 'warren'" \
#     warren-ext-tracker-ado
#
# The Azure DevOps credential arrives at runtime and is never written to
# disk or logged. Pass it as a secret in any orchestrator that has one.

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
# container is up without spending an Azure DevOps call every 30 seconds.
# It carries TRACKER_BEARER when one is set, or a protected container
# would answer its own healthcheck with a 401.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD bun -e "const t=process.env.TRACKER_BEARER;fetch('http://127.0.0.1:'+(process.env.TRACKER_PORT??'8080')+'/capabilities',{headers:t?{authorization:'Bearer '+t}:{}}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
