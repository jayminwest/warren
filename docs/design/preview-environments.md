# Per-Run Preview Environments + PR-Body Template

**Kind:** contract
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-08-01
**Shipped:** v0.3.2
**Current truth:** `src/runs/reap/preview.ts`, `src/server/main/preview-wiring.ts`, and `.warren/preview.yaml`

> **Salvage provenance:** lifted verbatim from the retired top-level spec §11.L (per-run
> preview environments, design lock for R-19) and §11.M (PR-body
> template) as part of the SPEC retirement plan `pl-1717` (step
> `warren-8777`). The wording below is the live contract — tests and
> doctor checks assert against it (e.g. the port-allocator "≥80%"
> doctor warning, the eviction defaults) — so edit it only in lockstep
> with the code it describes. Cross-references to other SPEC sections
> (§11.H, §11.N, §8.1, …) are repointed by the later sweep steps of
> `pl-1717`.

## Per-run preview environments (2026-05-14)

Design lock for R-19. Tracked by plan `pl-2c59` (root seed
`warren-1bcb`, design-lock step `warren-94d8`). Closes the R-19 open
questions; the implementing steps assume this section as contract.

**Status: shipped 2026-05-14.** All 11 implementation steps under
`pl-2c59` closed in sequence — burrow's cross-repo inbound-networking
+ sidecar-exec change (`burrow-8647`) landed first; warren-side
schema (migration 0009 + `RunsRepo.attachPreview`), SQLite-backed
port allocator, reap-time `preview_launch` + `pr_annotate_preview`
best-effort sub-steps, idle-TTL / max-lifetime / LRU eviction worker,
host proxy preamble + signed-cookie auth, manual teardown route,
RunDetail UI surface, and acceptance scenario `20-preview.ts`
(happy-path + idle-TTL eviction; macOS skipped per `mx-1d31f0`)
followed. Operator setup (wildcard CNAME, Caddy DNS-01 snippet, the
full `WARREN_PREVIEW_*` knob table) is documented in
[README](../../README.md#operator-setup) and
[`.env.example`](../../.env.example). Static-site previews
(`type: static`), PR-template configurability, the `.warren/` YAML
reorg, and a PR-close webhook → preview-teardown hook stay as
sibling follow-ups under `pl-2c59`. The PR-close webhook teardown
design is locked in §11.N (V2, awaits webhook receiver
infrastructure tracked next to R-18).

**Burrow-side dependency.** Burrow's bwrap profile is outbound-only
today (§8.1, `network: 'none' | 'restricted' | 'open'`), and the run
API is shaped around single-shot agent runs — neither an inbound
loopback port-forward nor a long-lived sidecar lifecycle exists on
burrow's HTTP surface. The cross-repo coordination seed is filed as
`burrow-8647` (consumed by warren-side step `warren-83dc`): warren
declares `inboundPortForwards: [{hostPort, sandboxPort}]` on the
sandbox profile and calls `POST /burrows/:id/sidecars` (with
parallel `GET / DELETE` and a `logs` endpoint) to spawn
`preview.command` alongside the finished agent run. Warren
orchestrates allocation, eviction, and TTLs; burrow enforces the
per-burrow forward + a small sidecar cap. Acceptance scenario 20's
Linux path exercises the full warren↔burrow seam; macOS skips per
`mx-1d31f0` because sandbox-exec doesn't isolate the network
namespace the same way.

**Project opt-in shape.** A project drops a `preview` block into
`.warren/preview.yaml` (canonical, warren-5840) — the top-level
document is the block itself. The same block is still accepted nested
under `preview:` in `.warren/config.yaml` or legacy `.warren/defaults.json`
for projects still on the old layout. The schema carries a `type`
discriminator from day one so we don't have to break the config when
the static-mode fallback lands:

    preview:
      type: server          # 'server' ships in V1; 'static' is a follow-up
      command: "bun run dev"
      port: 3000
      readiness_path: "/healthz"     # optional
      idle_ttl: "30m"                # default WARREN_PREVIEW_IDLE_TTL
      max_lifetime: "8h"             # default WARREN_PREVIEW_MAX_LIFETIME

V1 implements only `type: server`. `type: static` (build step + dir to
serve) is filed as a follow-up under the same plan; the schema accepts
the field but the launcher rejects with a "not yet implemented" error
that names the follow-up seed. Missing-block is not an error — projects
that haven't opted in simply skip the preview sub-step at reap.

**Reap-time launch (5th best-effort sub-step).** Mirrors the `pr_open`
pattern (`mx-05abb2`): a new `preview_launch` sub-step runs in
`src/runs/reap.ts` *after* `pr_open`, only when `outcome === 'succeeded'`
and the project opted in, never fails the run. Sequencing matters:
`pr_open` runs first and opens the PR with a
`<!-- warren:preview-placeholder -->` line embedded in the body so the
reviewer sees the PR immediately; `preview_launch` then asks burrow to
spawn `preview.command` as a long-lived sidecar in the same workspace,
allocates a port, and transitions `preview_state: starting → live` once
`readiness_path` (or a default `GET /`) returns 2xx. Once the preview
reaches `live` or `failed`, a third best-effort sub-step
`pr_annotate_preview` issues a `PATCH /repos/.../pulls/:n` to replace
the placeholder line with either the preview URL (live) or the failure
tail (failed). PR open does **not** block on preview ready; the
annotation patch is its own idempotent step. All three sub-steps emit
`reap_failed` events with `step` ∈ {`pr_open`, `preview_launch`,
`pr_annotate_preview`} on error and never mark the run failed.

**Two-phase readiness probe (warren-9b15).** The launcher splits its
wall clock into two named phases so sidecar startup overhead doesn't
eat the bundler budget:

1. **`connect` phase.** Cap: `connect_timeout` (default 5m). Covers
   shell pre-exec, dev-server CLI startup, dependency import-graph load,
   and port bind. Any HTTP response the server returns — even 4xx/5xx
   while the bundler still compiles — flips the loop into phase 2.
   Exhaustion surfaces as `LaunchFailureReason: 'connect_timeout'` —
   operator action is "check the sidecar's command (binding wrong host?
   port mismatch?), check burrow forwarder."
2. **`readiness` phase.** Cap: `readiness_timeout` (default 10m). Starts
   at first successful TCP connect, not sidecar create. Waits for 2xx/3xx
   from `readiness_path` (or `GET /`). Exhaustion surfaces as
   `LaunchFailureReason: 'readiness_timeout'` — operator action is
   "check the dev server's first-compile cost, possibly raise
   `readiness_timeout`."

`preview_failure_message` records the failing phase (`phase=connect:` /
`phase=readiness:`) so operators can tell which cap was actually hit.
Both timeouts accept the standard duration grammar (`1s..1h`) and are
overridable per-project under the `preview` block.

**Same sandbox, not a fork.** The preview runs in the same burrow
workspace the agent used. Forking would double burrow workload and
complicate port binding for marginal safety; the agent's side effects
(deleted files, half-applied migrations) are accepted as the cost of
realness. Failure mode surfaces as `preview_state: failed` with the
stderr tail in `preview_failure_message` — reviewers read "agent broke
the build" attributable to the agent's output, not warren.

**Lifecycle — idle-TTL is the primary signal.** Wall-clock TTL is the
wrong primary kill-rule: a reviewer mid-session shouldn't get their
preview yanked because N hours elapsed. The eviction worker
(`pl-2c59` step 7) combines four signals:

1. **Idle TTL.** The proxy updates `runs.preview_last_hit_at` on each
   request, **before** returning the response (a slow upstream must not
   make the preview look idle). Updates are debounced to ~once per 30s
   per run to keep the hot path cheap. Sweep evicts when
   `now - preview_last_hit_at > idle_ttl` (default 30 min, overridable
   per-project and via `WARREN_PREVIEW_IDLE_TTL`).
2. **Max lifetime ceiling.** Hard cap from launch time regardless of
   activity. Default 8h, overridable per-project and via
   `WARREN_PREVIEW_MAX_LIFETIME`. Stops the "browser tab from yesterday
   is still ticking the proxy" failure mode.
3. **Global LRU cap.** When `WARREN_PREVIEW_MAX_LIVE` (default 20) is
   reached and a new launch needs space, evict the longest-idle preview.
   Bounds container memory regardless of TTL choices.
4. **Manual teardown.** `POST /runs/:id/preview/teardown` is bearer-
   required, idempotent, emits `preview_torn_down`. UI exposes a button
   in `starting` / `live` states. Polite recourse when reviewer is done.

A V2 fifth signal — **PR-close webhook teardown** — funnels through the
same `teardownPreview` path with a structured `actor` tag once warren
ships a GitHub webhook receiver. Locked separately in §11.N to avoid
extending `EvictionReason` for code that can't land until the webhook
surface exists.

All eviction paths free the port and stop the sidecar process. The
**burrow workspace stays** — only the preview process dies. Workspace
cleanup is a separate concern keyed off the run's lifecycle, not the
preview's, so a re-launch (e.g. if R-12 remote-worker future ever wants
to re-spin a preview on a different host) is cheap.

**Auth — signed cookie, not bearer.** A run against private code
produces a preview that may contain secrets. Bearer-in-header is
impossible for a browser hitting `run-<id>.<host>` directly, so warren
issues a signed cookie from `POST /runs/:id/preview/login` — bearer in the
`Authorization` header, optional `{redirect}` body (ROADMAP option a;
warren-e1b0 moved the bearer out of the query string, where it would have
landed in history, `Referer` headers and proxy logs). Cookie scope is `Domain=.<warren-host>;
Path=/; HttpOnly; Secure; SameSite=Lax` **in subdomain mode**; path
mode narrows the scope to `Path=/p/<run-id>/` with no `Domain` (see
the "Routing modes — path vs subdomain" addendum below). The proxy
preamble verifies the HMAC before forwarding; unauthenticated requests
401, not 502. A doctor check warns when `WARREN_PREVIEW_HOST` is set
but `WARREN_API_TOKEN` is the default placeholder (mode-gated; see
addendum). GitHub OAuth (ROADMAP option b) defers to R-18; per-run
basic-auth password (option c) and no-auth (option d) stay rejected.

**Routing — in-process Bun route, not a separate reverse proxy.** The
proxy match (`Host: run-<id>.<host>` for subdomain mode; `/p/<run-id>/`
path-prefix for path mode — see the "Routing modes" addendum below)
lives in `src/server/main/index.ts` as a preamble before the API/UI routes.
It resolves `runs.preview_port` → `127.0.0.1:<port>` and forwards
HTTP + WS through `burrowClientPool.clientFor({burrowId})` so the
multi-worker placement (`warren-c0c9` / `pl-9ba1` step 5) keeps
holding. Cross-host (`runs.worker_id !== local`) returns **501 with
an explicit R-12 deferral message** — silent fall-through to a closed
loopback port would manifest as "preview works for some runs, not
others."

**TLS termination stays operator-side.** Per SPEC §8.1 / §11.D, TLS is
the operator's Caddy / cluster ingress. Warren ships docs for the wildcard
`*.<warren-host>` CNAME + DNS-01 wildcard cert with a Caddy snippet,
not built-in cert provisioning. The DEPLOY guide is honest about the
operator burden (DNS provider must be on Caddy's DNS-01 list; some are
paid).

**Port allocator persistence.** The allocator is SQLite-backed, not in-
memory. On warren startup, in-use ports are derived from
`SELECT preview_port FROM runs WHERE preview_state IN ('starting','live')`.
Default range `30000-31000`, configurable via
`WARREN_PREVIEW_PORT_RANGE`. Exhaustion emits a `preview_failed` event
with `reason='port_exhausted'`; a doctor warning fires when ≥80% of
the range is in use.

**Schema additions.** Migration 0009 adds five columns to `runs`.
Per R-13's dual-backend story (§3.2, §6), the migration lands in
**both** dialects in lockstep — `src/db/migrations/0009_*.sql` and
`src/db/migrations/postgres/0009_*.sql` — and the column declarations
land in **both** schema files (`src/db/schema/sqlite.ts` +
`src/db/schema/postgres.ts`). The preview-state enum tuple
(`['starting','live','failed','torn-down']`) lives in the shared
`src/db/schema/columns.ts` module so TS-side narrowing stays
dialect-agnostic.

    preview_state              TEXT NULL    -- (sqlite) / TEXT NULL (postgres). Enum: starting|live|failed|torn-down
    preview_port               INTEGER NULL -- (sqlite) / INTEGER NULL (postgres)
    preview_started_at         TEXT NULL    -- (sqlite ISO8601) / TIMESTAMPTZ NULL (postgres)
    preview_last_hit_at        TEXT NULL    -- (sqlite ISO8601) / TIMESTAMPTZ NULL (postgres); proxy-updated, debounced
    preview_failure_message    TEXT NULL    -- stderr tail on failure

`RunsRepo.attachPreview` is **async** (Promise-returning, matching the
post-R-13 repo layer from `pl-f17e` step 1) and mirrors `attachStats`'s
partial-input semantics (`mx-49272e`): omitted fields preserve existing
values; explicit `null` does not clear. Migration-parity CI lint
(R-13 acceptance #7) enforces lockstep on every commit.

**PR-template fragment contract.** The preview footer is a **named
template fragment** in the PR body that no-ops when the project hasn't
opted in. The full named-fragment registry shipped in `warren-bd49`:
`buildPrContent` (`src/runs/pr.ts`) composes its body from the
`PR_FRAGMENT_NAMES` registry in `src/runs/pr-template.ts`, and projects
override any fragment by shipping `.warren/pr-template.md` with `## name`
H2s. The `preview_url_or_placeholder` fragment is one entry in the
registry — same start/end markers, same idempotent annotate path. The
broader `.warren/` YAML reorg (one file per concern) is filed under the
same plan as a follow-up.

**Remote-worker (R-12) explicit deferral.** Cross-host preview routing
is out of scope. The proxy preamble asserts local-worker-only and
returns 501 with a clear R-12 deferral message; acceptance scenario 20
covers the assertion. When R-12 lands, this becomes the natural place
to splice in the worker-aware routing layer.

**Acceptance scenario number.** Scenario **20** (`20-preview.ts`), not
19 — scenario 19 (`19-warren-on-postgres.ts`) is taken by the R-13
dual-backend acceptance from `pl-f17e`. Per the dialect-aware `withDb()`
helper landed in `pl-f17e` step 6, scenario 20 should run on both
backends (SQLite default + `WARREN_TEST_DIALECT=postgres`) — preview
state, port allocator persistence, and eviction queries all touch the
DB seam that R-13 dual-tracks.

**`.warren/` reorg.** Shipped as warren-5840 under pl-2c59. The
canonical layout is one file per concern (`config.yaml`, `preview.yaml`,
`triggers.yaml`, `pr-template.md`); the legacy `defaults.json` still
loads with a deprecation warning, and `warren config migrate` converts
an existing install in place. See §11.H for the loader precedence and
the schemas in `src/warren-config/schema.ts` for the field-by-field
shape.

**Routing modes — path vs subdomain (warren-f4d7, pl-f4ea, 2026-05-15).**
The original §11.L lock above describes subdomain-mode routing
(`Host: run-<id>.<warren-host>`). That mode requires the operator to own
a domain, configure a wildcard CNAME, and provision a wildcard TLS cert
via DNS-01 — a closed door for the common self-hoster running a single-box
deploy. A second mode, **path mode**, reuses the single
hostname + cert that already serves the warren UI and adds zero
DNS/cert work. Path mode is the **default** from this addendum onward;
subdomain mode stays as the explicit opt-in for multi-tenant operators.

Selection knob:

```
WARREN_PREVIEW_MODE = path | subdomain        # default: path
```

(Also accepted as a top-level field in `.warren/preview.yaml` — but the
env var is the operator-facing surface; the per-project field exists
only so a project can pin a mode for its own previews when the operator
runs warren in a mixed configuration. The env wins on conflict, matching
the rest of `WARREN_PREVIEW_*`.)

**URL contract.** Path mode serves a run's preview at
`https://<warren-host>/p/<run-id>/...`. The run-id slug is the same
`[a-z0-9-]+` shape already used in `run-<id>.<warren-host>`. Subdomain
mode keeps the `https://run-<id>.<warren-host>/...` contract from the
original §11.L. No URL form ever serves a preview outside its
`/p/<run-id>/` (path mode) or `run-<id>.<host>` (subdomain mode) scope.

**Routing — path-prefix preamble.** The proxy preamble in
`src/server/main/index.ts` (mx-787718) grows a sibling match:

- Subdomain mode: existing `Host: run-<id>.<warren-host>` match.
- Path mode: regex `^/p/(?<runId>[a-z0-9-]+)(?<rest>/.*)?$` on the
  request path; strip `/p/<run-id>` before forwarding upstream. The
  upstream sees a request rooted at `<rest>` (or `/` when `rest` is
  empty), identical in shape to what subdomain mode forwards today.

Both branches share the rest of the seam: resolve
`runs.preview_port → 127.0.0.1:<port>` via
`burrowClientPool.clientFor({burrowId})`, forward HTTP + WS, update
`runs.preview_last_hit_at` with the 30s-debounce (mx-411a6f), 501 on
cross-host (`runs.worker_id !== local`) with the R-12 deferral message,
404 (not 502) on unknown run-id. The eviction worker, port allocator,
and reap-time `preview_launch` / `pr_annotate_preview` sub-steps stay
mode-agnostic.

**HTML rewrite contract (path mode only, best-effort).** Root-relative
asset URLs (`/assets/foo.js`) and dev-server `Location:` redirects
(`Location: /signin`) would escape the `/p/<run-id>/` prefix and 404
against warren's UI/API routes. The path-mode proxy applies two
response transforms:

1. **`<base href>` injection.** When the upstream response
   `Content-Type` is `text/html` (parameters tolerated), inject
   `<base href="/p/<run-id>/">` immediately after the opening `<head>`
   tag. Skipped when the document already declares a `<base>` element
   (idempotent — re-proxying the warren-served HTML is a no-op).
   Rewrites are bounded to the first 64 KiB of body; larger documents
   without a `<head>` in the first 64 KiB pass through untouched and
   accept the breakage (the apps that hit this are rare enough that
   subdomain mode is the right escape hatch).
2. **`Location:` header rewrite.** On any 3xx response, if `Location:`
   parses as a same-origin or scheme-relative path that starts with `/`
   and does **not** already start with `/p/<run-id>/`, rewrite to
   `/p/<run-id>/<rest>`. Absolute URLs to external origins pass through
   untouched. `Location:` values that already start with `/p/<run-id>/`
   are not double-prefixed.

JSON, JS, CSS, images, fonts, and all other non-HTML content types pass
through byte-for-byte. The rewriter is best-effort: an upstream that
streams chunked HTML without a parseable `<head>` in the first chunk
gets no `<base>`, but the proxy never errors the response over this.

**Cookie scope per mode.** The signed-cookie auth (`src/preview/cookie.ts`,
mx-c38965) parameterizes scope by mode:

- Subdomain mode (unchanged): `Domain=.<warren-host>; Path=/; HttpOnly;
  Secure; SameSite=Lax`.
- Path mode: `Path=/p/<run-id>/; HttpOnly; Secure; SameSite=Lax`. No
  `Domain` attribute. Two previews on the same warren host hold
  independent path-scoped cookies; a reviewer can be authenticated to
  multiple previews simultaneously in the same browser.

The HMAC and token shape are identical across modes. The login route
`POST /runs/:id/preview/login` stays the canonical entry point; in path
mode it sets the path-scoped cookie and answers with the
`/p/<run-id>/<redirect-or-slash>` URL to navigate to. Unauthenticated requests on the
proxied path 401 (not 502) just as in subdomain mode.

**PR annotation URL shape.** `src/runs/pr-annotate.ts` (mx-ba79c4)
branches on mode when composing the `preview_url_or_placeholder`
fragment: `https://<warren-host>/p/<run-id>/` in path mode,
`https://run-<id>.<warren-host>/` in subdomain mode. The
`<!-- warren:preview-start --> / <!-- warren:preview-end -->` markers
are unchanged; the annotate step stays idempotent across mode flips
between reap and re-annotate (a project that flips modes mid-PR will
see a single replacement, not duplicate markers).

**Doctor checks per mode.** The existing `checkPreviewAuthStrength`
(mx-f2cf0b) warning — `WARREN_PREVIEW_HOST` set with placeholder
`WARREN_API_TOKEN` — still applies in both modes. The
`WARREN_PREVIEW_HOST`-required warning becomes **mode-gated**: in path
mode `WARREN_PREVIEW_HOST` is optional (warren derives the preview
origin from the request's own `Host`), so the warning fires only in
subdomain mode. Wildcard-DNS / DNS-01 cert advisories are
subdomain-only.

**Single-tenant-per-host caveat.** Path mode shares one cookie jar
(scoped by `/p/<run-id>/`) across all previews on the warren host. The
Path scope keeps sessions distinct per run, but an organization that
wants org-scale previews — many reviewers, many projects, dozens of
concurrent previews — should run subdomain mode. Path mode is sized
for solo-operator and small-team deploys, which is exactly the
audience that motivated this follow-up.

**Trade-offs accepted by path mode.**

- Apps that compute URLs from `window.location.host` and assume
  `host == app-origin` (rare in modern SPAs, common in older PHP-style
  apps) may misbehave under `/p/<run-id>/`. Operators with such apps
  use subdomain mode. The trade-off is documented; warren does not
  rewrite JS at runtime.
- Some dev servers (Vite, Next, CRA) honor `<base href>` for asset
  resolution but require an explicit `--base` flag for HMR websocket
  paths. Projects configure the framework-specific base via their
  existing `preview.command` in `.warren/preview.yaml` — warren ships
  `<base>` injection as best-effort and documents the known-good
  shapes; it does not synthesize per-framework wrappers.

**Acceptance coverage.** Scenario `20-preview.ts` (the existing
Linux-only happy-path + idle-TTL scenario) gains a path-mode sibling
(`20-preview-path.ts`, or a parametrized variant of the same scenario)
that boots warren with `WARREN_PREVIEW_MODE=path`, exercises the
`/p/<run-id>/` URL end-to-end (cookie issuance, `<base>` injection,
`Location:` rewrite on a redirect), and verifies that the
wildcard-host doctor warning does **not** fire when
`WARREN_PREVIEW_HOST` is unset. macOS still skips per mx-1d31f0.

**Dedicated preview origin — path mode (warren-3f8a, 2026-08-03).**
The original path-mode addendum served previews from warren's own
listener, which put agent-authored preview code on the same browser
origin as the warren UI. The UI keeps the operator bearer token in
`localStorage`, and any same-origin script can read it — a
prompt-injected agent plus one operator click on "Open preview" equals
operator-token theft. Documented for a while as a V1 limitation; closed
by moving path-mode previews onto a **dedicated listener**:

- `WARREN_PREVIEW_PORT` (default: bind port + 1) binds a second
  `Bun.serve` on the same hostname (`src/server/preview-server.ts`)
  that serves nothing but the preview proxy. Same URL contract
  (`/p/<run-id>/...`), same cookie handshake, same rewrites — only the
  origin changes. `bootPreviewSurface`
  (`src/server/main/preview-wiring.ts`) is the topology decision point.
- The browser treats `host:8080` and `host:8081` as different origins,
  so the preview cannot touch the UI's storage. They stay the same
  *site*, so the host-scoped `SameSite=Lax` preview cookie set by the
  login handshake on the warren origin still flows to the preview
  origin — no cookie-attribute change was needed.
- The warren origin answers `/p/<run-id>/...` with a **308** to the
  preview origin (`createPreviewPathRedirect`), keeping pre-split
  bookmarks and PR annotations working. 308 because it is cacheable and
  method-preserving.
- The old `isWarrenApiPath` carve-out in referer-based asset routing is
  deleted: the preview listener has no warren API to protect, and a
  preview reaching for the control plane must now cross origins
  explicitly — which is the point.
- The login handshake resolves `redirect` targets against the preview
  origin (`deps.previewPort`), and `GET /preview/config` discloses the
  port so the UI renders the canonical URL.
- The unix-socket transport has no TCP port to bind; it keeps the
  legacy same-origin mounting and warns at boot naming warren-3f8a.
  Subdomain mode is unchanged — its origin boundary is the per-run
  host.
- Operator impact: publish the preview port next to the API port.
  docker-compose maps `"${WARREN_HOST_PREVIEW_PORT:-8081}:8081"`; a
  reverse proxy forwards a second port on the same hostname.

## PR-body template (warren-bd49, 2026-05-14)

`buildPrContent` (`src/runs/pr.ts`) composes the PR body from a fixed
registry of **named fragments** (`PR_FRAGMENT_NAMES` in
`src/runs/pr-template.ts`):

```
title                         → drives the PR title (truncated to 72 chars)
summary                       → first commit subject or "agent ran for X; no commits."
run                           → warren UI link, agent, duration, cost
seeds                         → "id — title" when the prompt referenced a seed
preview_url_or_placeholder    → §11.L preview footer (start/end markers)
commits                       → "## Commits (N)" bullet list
files_changed                 → `git diff --stat` fenced block
prompt                        → collapsed `<details>` audit trail
trailer                       → footer / signature
```

The registry — not inline string concatenation — is what assembles the
body. Each fragment has a default renderer that no-ops when its data
isn't present (e.g. the `seeds` fragment renders nothing when no seed
was resolved). The `preview_url_or_placeholder` fragment is one entry
in the same list; the §11.L `pr_annotate_preview` step patches it
later using the same `<!-- warren:preview-start -->` /
`<!-- warren:preview-end -->` markers it always has.

**Project overrides.** A project ships `.warren/pr-template.md` with
H2 headings whose names match fragment names:

```markdown
## trailer

Reviewed-by: @platform-team

Please follow our [PR checklist](https://example.com/checklist) before merging.
```

Override semantics:

- Fragment-by-fragment: missing keys keep the default; explicit body
  replaces it wholesale.
- Whitespace-only body removes the fragment from output entirely.
- Names are normalized to snake_case so `## Files Changed`,
  `## files-changed`, and `## files_changed` all match `files_changed`.
- Variable interpolation is **not** supported in V1 — overrides are
  literal markdown. Projects that need per-run dynamic data keep the
  default fragment for that section.

**Doctor / readyz coverage.** Unknown fragment names and unbalanced
preview markers (one of `<!-- warren:preview-start -->` /
`<!-- warren:preview-end -->` without the other) surface as
`warren_config_schema_error` entries on `.warren/pr-template.md`. The
existing `checkWarrenConfig` probe aggregates them across projects —
no new diagnostic check needed.

**Wire-up.** `bridges.ts` resolves the project's parsed overrides via
the same `WarrenConfigCache` it uses for `previewConfig`, then threads
them into `reapRun({ prTemplate })` on succeeded-outcome reaps.
`buildPrContent` accepts `templateOverrides` and forwards into
`composeBody` / `composeTitle`. Failures from the loader fall through
to the built-in defaults — the PR still gets opened.

