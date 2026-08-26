# MCP server

**Kind:** proposal
**Design state:** draft
**Delivery:** unscheduled
**Arrived:** 2026-08-26
**Related:** [`extensions.md`](extensions.md),
[`forge-contract.md`](forge-contract.md), and the multi-user auth
widening deferred in [`ROADMAP.md`](../../ROADMAP.md) (2026-08-03)

## Summary

Warren should expose itself to MCP hosts — Claude Code, Claude
Desktop, claude.ai, editors — through a Model Context Protocol server
that fronts the existing HTTP API. The server is an **extension**
(`extensions/mcp-server/`), not a core feature: it consumes only the
published HTTP surface, ships as its own npm package, and warren core
never knows it exists.

This record is investigation output, not a plan. Nothing is scheduled.
The sequencing question it answers: the MCP server does **not** depend
on team settings or multi-user auth. It authenticates the way the CLI
does — one bearer token from the environment. What waits on named
tokens is not building the server but promoting it as the per-engineer
team on-ramp, where every engineer's editor holds a warren connection
and dispatches need attribution.

## Why

- **Reach.** The CLI covers agents with shell access. An MCP server
  covers everything else: Claude Desktop, claude.ai custom connectors,
  VS Code, Cursor, and permission-gated environments where a shell is
  unavailable. "Ask Claude to dispatch a cloud agent on this issue and
  watch the PR land" becomes demoable from a chat window.
- **Cheap.** The three hard parts already exist: a stable route table
  with generated OpenAPI (`gen:openapi:check`), golden-snapshotted
  error envelopes, and the `WARREN_BASE_URL` / `WARREN_API_TOKEN` env
  contract. The MCP server is a curated adapter, not a new surface.
- **Dogfooding.** Warren's own operator drives warren from Claude Code
  sessions today. An MCP connection replaces ad-hoc `curl` and CLI
  calls in those sessions.

## Landscape snapshot (2026-08-26)

Facts below come from the spec, the SDK release notes, and host
documentation current as of this record's date. They set the build
constraints and will drift; re-verify before implementation.

- **Spec.** Current stable revision is **2026-07-28**, a major break:
  MCP is now stateless. The `initialize` handshake and protocol-level
  sessions (`Mcp-Session-Id`) are gone; every request carries its
  protocol version, and cross-call state must travel as explicit
  server-minted handles in ordinary tool arguments. Server-initiated
  requests (sampling, elicitation) became multi-round-trip
  `input_required` results. Roots, Sampling, and Logging are
  deprecated with a 12-month window.
- **SDK.** The TypeScript SDK v2 is stable: the `@modelcontextprotocol/sdk`
  monolith split into `@modelcontextprotocol/server` and
  `@modelcontextprotocol/client` (2.0.0), ESM-only, with **Bun
  explicitly supported** and Standard Schema (Zod v4 et al.) for tool
  schemas. `serveStdio()` covers stdio; `createMcpHandler` serves
  Streamable HTTP and transparently handles legacy 2025-11-25 clients
  on the same endpoint.
- **Transports.** Streamable HTTP is the recommended remote
  transport; the old HTTP+SSE transport is formally deprecated. stdio
  remains the norm for locally spawned servers.
- **Auth.** The spec's remote-auth story is OAuth 2.1 with Protected
  Resource Metadata (RFC 9728) and mandatory RFC 8707 resource
  indicators. The pragmatic norm for self-hosted servers remains a
  static bearer header: Claude Code supports
  `--header "Authorization: Bearer ..."` and env-var expansion in
  `.mcp.json`, and fails closed (no OAuth fallback) when a configured
  header is rejected. claude.ai custom connectors are the exception:
  OAuth or unauthenticated only (weakly sourced; re-verify).
- **Primitive support.** Tools are the only reliably portable
  primitive across Claude Code, Claude Desktop, claude.ai, VS Code,
  and Cursor. Resources and prompts have partial support. Sampling and
  elicitation are unsupported by most Claude-family hosts and now
  deprecated or restructured in the spec. Design for tools; treat
  everything else as progressive enhancement.
- **Host budgets.** Claude Code caps a tool result at 25,000 tokens
  and truncates tool descriptions and server instructions at 2 KB.
  Its tool-search feature defers tool definitions, so the server-level
  `instructions` field is the discovery surface that matters most.
- **Distribution.** The official MCP registry
  (registry.modelcontextprotocol.io) is operational and metadata-only;
  packages live on npm and are declared via `server.json` plus an
  `mcpName` field in `package.json`. Local servers run via
  `npx` / `bunx`. Claude Desktop additionally accepts MCPB bundles
  (the format formerly named DXT).

The stateless 2026-07-28 model is a gift to warren: run ids, project
ids, and plan-run ids are already the explicit handles the spec now
requires. Nothing about warren's REST shape fights the protocol.

## Architecture

### Home and seam

`extensions/mcp-server/` — own `package.json`, lockfile, tsconfig, and
tests, published as `@os-eco/warren-mcp`. The extensions seam
(`check:layers`) forbids importing `src/**`, so the server speaks the
published HTTP API directly, with `docs/openapi.yaml` as the
reference contract. If the client SDK (`src/client/`) ever publishes
as its own package, the extension may depend on that package like any
outside consumer; it still never imports `src/`.

Every place the HTTP surface fights an MCP client's needs goes in the
extension's `FRICTION.md`, the same protocol `extensions/audit-log/`
established.

### Transport shape

Two entry points, one codebase, both trivial under SDK v2:

1. **stdio** (v1 target) — `bunx @os-eco/warren-mcp`, spawned by the
   host, proxying to warren over HTTP. Reads `WARREN_BASE_URL` and
   `WARREN_API_TOKEN` from the environment, identical to the CLI env
   contract. Works in every host today.
2. **Streamable HTTP** (fast follow) — the same server behind
   `createMcpHandler`, deployed as a sidecar next to warren for
   remote hosts (claude.ai connectors, hosted Claude Code). Not part
   of warren's own `Bun.serve`; the extension seam keeps it a
   separate process.

### Auth

v1 is bearer pass-through: the token the environment supplies goes on
every upstream request, and warren's existing `Actor` / `policyAllows`
machinery decides what it can do. A read-only token yields a read-only
MCP server with no extra code.

The OAuth / Protected Resource Metadata path is the upgrade, not the
floor, and it lands together with the multi-user auth widening the
roadmap deferred on 2026-08-03. Named bearer tokens with subjects —
the "cheap first step" that decision reserved — are the gate for
promoting the MCP server as a team on-ramp: one token per engineer,
`dispatched_by` on every run, revocation per person. This record
takes no position on when that happens.

## Tool surface (v1 sketch)

Curated, not generated. The route table serves 47 routes; mirroring
them would flood host tool budgets and bury the useful verbs. The
sketch is roughly eleven tools, prefixed `warren_`, with read tools
marked `readOnlyHint` (an untrusted hint, but free):

| Tool | Kind | Fronts |
|---|---|---|
| `warren_health` | read | `GET /healthz`, `GET /version` |
| `warren_list_projects` | read | `GET /projects` |
| `warren_list_runs` | read | `GET /runs` (filtered, paginated) |
| `warren_get_run` | read | `GET /runs/:id` |
| `warren_get_run_events` | read | bounded tail: last N events + current status |
| `warren_dispatch_run` | write | `POST /runs` |
| `warren_steer_run` | write | steering-inbox post |
| `warren_cancel_run` | write | run cancellation |
| `warren_dispatch_plan_run` | write | `POST /plan-runs` |
| `warren_get_plan_run` | read | plan-run status |
| `warren_list_agents` | read | `GET /agents` |

Rules the sketch commits to:

- **No streaming.** MCP tools are request/response. The event tail
  returns the newest N events plus run status and tells the model to
  call again; it never holds a connection open. The ndjson stream
  stays a CLI/UI feature.
- **Bounded results.** Every list tool paginates with a default page
  size chosen to keep results far under the 25k-token host cap, and
  each result says how to fetch more.
- **Structured output.** Tools declare `outputSchema` and return
  `structuredContent` whose shapes match the wire vocabulary in
  `src/core/wire.ts` — matched by contract (OpenAPI), not by import,
  because the seam forbids the import.
- **Descriptions are the product.** Per current guidance, tool
  descriptions state when *not* to use a tool, and the ≤2 KB server
  `instructions` field carries the "warren dispatches ephemeral cloud
  agents; runs are async; poll with warren_get_run" framing that makes
  tool search find the right verb.

Admin routes (project create/delete, token management) stay off the
v1 surface on purpose. An MCP host is a dispatch-and-observe client;
administration keeps a human at the CLI or UI.

## What this record does not decide

- The final tool list and schemas. The table above is a sketch.
- Whether warren core should ever serve `/mcp` natively. That would
  cross the extensions seam on purpose and needs its own record.
- MCP registry publication and MCPB bundling. Distribution polish
  follows a working v1.
- Resources or prompts (for example, run logs as MCP resources).
  Host support is partial; tools come first.
- Anything about named tokens. That design belongs to the deferred
  multi-user widening, not to this record.

## Promotion trigger

Two independent triggers, either sufficient:

1. The operator's own sessions want warren tools in a host where the
   CLI is unavailable or unergonomic (dogfooding pull).
2. Named bearer tokens with subjects get scheduled, making the
   per-engineer team on-ramp real (team pull).

## Sources

Research snapshot dated 2026-08-26; verify against these before
implementation.

- MCP specification 2026-07-28 changelog and release post —
  modelcontextprotocol.io/specification/2026-07-28/changelog,
  blog.modelcontextprotocol.io/posts/2026-07-28/
- TypeScript SDK v2 (`@modelcontextprotocol/server` 2.0.0) —
  ts.sdk.modelcontextprotocol.io/v2/,
  blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/
- Authorization spec (OAuth 2.1, RFC 9728, RFC 8707) —
  modelcontextprotocol.io/specification/draft/basic/authorization
- Claude Code MCP docs (transports, headers, output caps) —
  code.claude.com/docs/en/mcp
- Host primitive-support matrix — canimcp.dev
- Anthropic, "Writing effective tools for agents" —
  anthropic.com/engineering/writing-tools-for-agents
- MCP registry quickstart — modelcontextprotocol.io/registry/quickstart
