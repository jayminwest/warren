# syntax=docker/dockerfile:1
# @warren-ext/tracker-conformance — FakeTracker, the reference
# warren-tracker/v1 server (warren-53ea).
#
# This image builds from THIS DIRECTORY ALONE (docs/design/extensions.md §2):
#   docker build -t warren-ext-tracker-conformance .
#
# Run it given nothing but a port mapping:
#   docker run --rm -p 8080:8080 warren-ext-tracker-conformance
# Optional knobs ride env: FAKE_TRACKER_FIXTURE (path, mount one),
# FAKE_TRACKER_STATE_FILE, FAKE_TRACKER_BEARER.

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

RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun

ENV FAKE_TRACKER_PORT=8080 \
    FAKE_TRACKER_STATE_FILE=/app/data/fake-tracker-state.json

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD bun -e "fetch('http://127.0.0.1:'+(process.env.FAKE_TRACKER_PORT??'8080')+'/capabilities').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD bun run src/fake-tracker.ts \
	--port ${FAKE_TRACKER_PORT} \
	--state-file ${FAKE_TRACKER_STATE_FILE} \
	${FAKE_TRACKER_FIXTURE:+--fixture ${FAKE_TRACKER_FIXTURE}} \
	${FAKE_TRACKER_BEARER:+--bearer ${FAKE_TRACKER_BEARER}}
