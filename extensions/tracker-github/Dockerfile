# syntax=docker/dockerfile:1
# Standalone extension: docker build -t tracker-github extensions/tracker-github
FROM oven/bun:1.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
FROM oven/bun:1.2-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir /state && chown bun:bun /state
USER bun
ENV TRACKER_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
 CMD bun -e "const t=process.env.TRACKER_BEARER;fetch('http://127.0.0.1:'+(process.env.TRACKER_PORT??'8080')+'/capabilities',{headers:t?{authorization:'Bearer '+t}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/index.ts"]
