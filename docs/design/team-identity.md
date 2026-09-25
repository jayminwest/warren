# Team identity, grants, and brokered credentials

**Kind:** direction
**Design state:** proposed
**Delivery:** unscheduled
**Arrived:** 2026-09-24
**Related:** [`mcp-server.md`](./mcp-server.md),
[`forge-contract.md`](./forge-contract.md) §4 (credential minting),
[`runtime-provider-contract.md`](./runtime-provider-contract.md),
[`corpus-flywheel.md`](./corpus-flywheel.md) §0 (the positioning this
record replaces), and the 2026-07-29
[planning-session record](./2026-07-29-planning-session-record.md)
(the original auth-widening scope)

This record proposes that Warren become a control plane a team shares.
It fixes the thesis, the nouns, the credential-delivery model, and the
phase order. It does not approve table schemas, wire shapes, or a
release. Seeds hold those at implementation time.

Nothing here is scheduled. The owner decided on 2026-09-24 to drop the
research direction (the external-repository mirror pilot and the
corpus flywheel positioning) in favor of this one. The ROADMAP
amendment that records that decision is a separate change. Until it
lands, this record stays `unscheduled`.

---

## 1. Why

Dispatch, sandbox, and pull request are table stakes in 2026. Every
vendor ships them. The questions that engineering leaders cannot yet
answer are about governance:

1. Who is this agent acting as, and what can it reach?
2. What did it cost, and who pays?
3. Can I reproduce it, compare it, and trust its output?

Warren today answers none of them for more than one person. It has
one operator token. Every run, every extension, and every human share
that one identity. Model provider keys enter the sandbox as raw
environment variables. That posture is honest for a solo instrument.
It is wrong for a team.

The earlier positioning (corpus-flywheel §0, 2026-08-15) said Warren
is not a product, and it used that to keep the auth widening deferred.
This record reverses that position. A team deployment is now the
payer that PHILOSOPHY rule 1 asks for.

Two things do not change:

- **One deploy serves one team.** A team is not multi-tenancy. No
  organizations, no workspaces, no billing.
- **Self-hosted.** The deployment remains the unit of trust. Warren
  holds the team's credentials because the team runs Warren.

## 2. The thesis

> Every action has a principal. Every run acts for one, with a
> narrowed, expiring grant. No long-lived secret enters a sandbox.

Each clause is testable:

- **Every action has a principal.** Each HTTP request, run, event, and
  commit resolves to a named user or service account. The anonymous
  spectator of `WARREN_AUTH=public` is the only exception, and it
  cannot mutate.
- **Every run acts for one.** A run records who dispatched it and the
  chain of automation between that human and the run.
- **Narrowed, expiring grant.** A run can do less than its principal,
  never more. Its authority ends when the run ends.
- **No long-lived secret enters a sandbox.** `env` inside a running
  agent shows no model key, no forge PAT, and no MCP credential.

The falsification test (PHILOSOPHY, Seams): a run that can read a
credential its dispatcher could not use, or any durable secret visible
inside a sandbox, proves the design failed.

## 3. Current state

What exists, and what each part contributes.

| Area | Today | Gap |
|---|---|---|
| Actor model | `Actor` is `operator`, `anonymous`, or `run`, with four capability flags: `readPublic`, `readOperator`, `dispatch`, `admin` (`src/server/auth.ts`, warren-1ff0) | No `subject`. `authorize` is synchronous. |
| Human credentials | One operator token, bootstrapped at first boot or read from `WARREN_API_TOKEN` | No names, no revocation per person, no attribution |
| Run tokens | Stateless HMAC over the run id, keyed by the operator token (`src/runs/spawn/run-token.ts`, warren-57fd). Pinned to the run's own callback routes and dead at terminal state. | Carries no principal. Operator-token rotation breaks every live run. |
| Git credentials | The forge mints a short-lived per-run push credential and the pod re-mints it on demand (forge-contract §4) | None. This is the pattern to copy. |
| Model credentials | Deployment env vars (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and so on) forwarded raw into the sandbox (`src/core/providers.ts`) | The agent can read and exfiltrate them. A Claude subscription token belongs to one person, so a shared instance cannot use it for the whole team. |
| Egress | Local runs go through a per-run allowlist proxy (`src/sandbox/proxy-server.ts`). K8s run pods get coarse NetworkPolicy egress with open external traffic (`deploy/k8s/base/networkpolicy.yaml`). | K8s has no proxy hop. The broker needs one. |
| Extensions | audit-log, judge, and campaign-controller each hold the full operator token | They need service accounts with narrow scopes. This payer exists today. |
| Runs table | Has `trigger` | No `dispatched_by`, no delegation chain |
| MCP | Warren as an MCP server is a draft extension (`mcp-server.md`). MCP servers for agents are "Tier 0, not in core" (ROADMAP). | This record reverses the second position (§6). |

The 2026-07-29 planning record scoped the widening as async
`authorize`, `Actor.subject`, sessions, and `run.dispatched_by`. It
set one hard gate: no second human login before scoped tokens ship.
Scoped run tokens shipped in v0.13.0, so the gate is clear.

## 4. The nouns

Five nouns. Each one is small on purpose.

### 4.1 Principal

A user or a service account.

- **User.** A human, linked to a GitHub identity (§5).
- **Service account.** A non-human caller: an extension, the
  scheduler, a trigger, the campaign controller. An admin creates it.
  It holds tokens but never logs in.

The operator token that exists today becomes the credential of a
bootstrap admin principal. An existing deployment keeps working with
no config change.

### 4.2 Token

A bearer credential that belongs to one principal.

- Named, hashed at rest, with an optional expiry and a last-used time.
- Scopes narrow the principal's role. A token can never exceed its
  principal.
- A recognizable prefix per kind, so secret scanners and the log
  scrubber can match it.
- Revocation is immediate. `authorize` becomes async and checks the
  store (the 07-29 scope already names this).

The CLI's `warren login` browser handoff (warren-48f8) mints a personal
token for the human who completes it. No human pastes a shared token
again.

### 4.3 Role

`admin`, `member`, or `viewer`, mapped onto the capability flags that
already exist:

| Role | readPublic | readOperator | dispatch | admin |
|---|---|---|---|---|
| viewer | yes | yes | no | no |
| member | yes | yes | yes | no |
| admin | yes | yes | yes | yes |

Roles are instance-wide in v1. Per-project roles wait for a real
request. The policy layer (`policyAllows`, one check per route)
does not change shape. Only the source of the flags changes.

There is no permission matrix and no custom role editor. The opinion
is capabilities, not permissions.

### 4.4 Run grant

The run token grows from "a run id" to a grant:

- the run id
- the principal the run acts for (`dispatched_by`)
- the delegation chain: a trigger owned by X, a plan-run child of a
  plan-run X started, a pr-fixer run spawned for a run X dispatched
- the capabilities the run holds
- the connections bound to the run (§4.5)

Rules:

- **Attenuation.** A grant never exceeds its principal. A run that
  causes another run (healer, pr-fixer, plan-run advance) passes a
  grant that is equal or narrower.
- **Lifetime.** The grant dies at terminal state, as run tokens do
  today.
- **Signing key.** A dedicated signing secret replaces the operator
  token as the HMAC key. Operator-token rotation stops breaking live
  runs.
- **Recording.** `dispatched_by` and the chain go on the run row and
  on every run event, so the event stream and the audit-log extension
  carry the subject with no extra join.

Automated dispatches name a human at the root of the chain. A
schedule belongs to the user who created it. A trigger belongs to the
user who wrote it into `.warren/triggers.yaml`, or to a service
account when no human owns it.

### 4.5 Connection

A named credential that runs can use but never see.

- **Kinds:** model provider, MCP server, generic HTTP secret.
- **Owner:** the team (created by an admin) or one user.
- **Resolution.** A user's connection overrides the team's for runs
  that user dispatches. Example: a member attaches a personal Claude
  subscription. Their runs use it, and every other run uses the team
  API key. Automated runs with no human override use the team
  connection. The run records which connection it used, so cost
  attribution can tell them apart.
- **Storage.** Encrypted at rest with a deployment key. The key comes
  from the environment or a mounted secret, never the database.

## 5. Human login

GitHub OAuth, through the GitHub App each deployment already
registers.

The manifest flow already returns the App's client id and client
secret (`src/forge/github-app/`). GitHub Apps support user-to-server
OAuth with those same credentials. So login needs no new IdP, no new
registration, and no new secret. Every Warren user already has a
GitHub account.

- **Sessions.** An HTTP-only, same-site cookie for the UI. The SPA
  stops storing a bearer token in `localStorage`.
- **Membership.** An admin invites a GitHub login, or allows members
  of a GitHub org or team. An unknown GitHub user who signs in gets no
  access until an admin admits them.
- **CLI.** `warren login` opens the browser, the user signs in, and the
  handoff mints a personal token. The piped-token path stays for
  headless use.
- **Generic OIDC** (Okta, Google, Entra) arrives later as another
  `AuthProvider` implementation, when a deployment asks for it.
  Putting an auth proxy in front of Warren stays supported.

This amends the 2026-08-03 decision "the GitHub App is a credential
mechanism, not an identity provider." The App becomes both. The other
2026-08-03 decision stands: the public instance stays read-only, and
spectators never authenticate.

## 6. Credential delivery: the broker

The sandbox gets placeholders. Warren adds the real credential on the
way out. Three delivery paths, in order of preference.

### 6.1 Mint

Where the upstream supports short-lived credentials, Warren mints one
per run. Git already works this way. GitHub App installation tokens
and OAuth refresh flows follow the same path.

### 6.2 Inject at the egress proxy

For model APIs and plain HTTP services, the sandbox holds a
placeholder value and a base URL that routes through the per-run
proxy. The proxy matches the destination against the run's bound
connections and adds the real `Authorization` or API-key header.

- **Local runtime.** The per-run proxy exists. It gains header
  injection for HTTPS by terminating TLS for bound hosts only, with a
  per-run CA the sandbox trusts. Unbound hosts keep the plain CONNECT
  tunnel.
- **K8s and Docker.** There is no proxy hop today. The options are an
  in-pod sidecar proxy or an egress gateway in the control plane.
  This record does not choose. The sidecar keeps traffic off the
  control plane. The gateway makes the credential never leave the
  control-plane pod. Choose at implementation, after a measurement.
- **Base-URL rewrite.** Where a harness honors a provider base URL
  (`ANTHROPIC_BASE_URL`, `OPENROUTER_BASE_URL`, and the others already
  listed in `src/core/providers.ts`), Warren can point it at a
  control-plane model endpoint and skip TLS interception. Prefer this
  when it works.

A side effect: every model call now passes a Warren-owned hop. Usage
and cost come from the hop, not from harness self-reports. That
removes the dual-extractor problem the 07-29 record flagged as a
money-reporting risk.

### 6.3 MCP gateway

The agent's MCP config names Warren, not the upstream server:
`<warren>/runs/:id/mcp/:connection`, authenticated with the run's
grant. Warren proxies each Streamable HTTP request upstream with the
connection's credential.

The gateway does four things in one place:

1. **Least privilege.** The agent profile names which tools of which
   connection a run may call. Warren drops calls outside the list.
2. **Attribution.** Upstream sees the dispatcher's credential, so the
   third-party system (Linear, Sentry, a database) sees the right
   human.
3. **Audit.** Each tool call becomes a run event with the tool name,
   the connection, the duration, and the result status. The run detail
   page and the audit-log extension show it with no new pipeline.
4. **Revocation.** Revoke a connection and every live run loses it at
   its next call.

Stdio MCP servers that a project starts inside its own sandbox stay
Tier 0 project tooling, as today. The gateway covers the remote
servers that hold real credentials.

This reverses the ROADMAP entry "MCP server management — Tier 0, not in
core." The earlier entry was right when MCP credentials were a
project's own business. Once credentials belong to named principals,
brokering them is the control plane's job. The broker cannot sit in an
extension, because it must run before the credential leaves Warren.

## 7. Surfaces

### UI

- **Settings → Members:** invite, set role, remove.
- **Settings → Tokens:** personal tokens, and service accounts for
  admins.
- **Settings → Connections:** team and personal connections, and a
  test button that proves the credential works without showing it.
- **Agent profiles:** runtime, model, connections, and MCP tool
  allowlist as one named object. The dispatch form picks a profile
  instead of free-text provider and model fields.
- **Run detail:** dispatched by, delegation chain, bound connections,
  and the tool-call audit.
- **Runs and analytics:** a "mine" filter, and cost by principal and by
  connection.

### CLI

`warren login` (browser), `warren whoami`, `warren tokens
create|list|revoke`, `warren members`, and `warren connections`. Each
command wraps an HTTP route, like every CLI command today.

### Git and forge

- Agent commits keep the bot author (Article VII) and add a
  `Co-authored-by:` trailer for the dispatching user.
- PR bodies name the dispatcher.

### Budgets

Per-principal spend caps are enforced at dispatch admission, beside
the per-run cap. ROADMAP listed per-user budgets as a Tier 1 extension.
That entry assumed identity lived outside core. A cap must reject
before spend, so admission owns it. Budget reporting can stay on the
bus.

## 8. Phases

Each phase ships alone and demos alone.

| Phase | Delivers | Demo |
|---|---|---|
| 1. Principals and tokens | Principal and token store, async `authorize`, `Actor.subject`, `dispatched_by` and chain on runs and events, dedicated grant signing key, service accounts for the three extensions, `warren tokens` and `warren whoami`, Tokens page | Every run says who did it |
| 2. Login and members | GitHub OAuth through the App, sessions, invites and org admission, roles, CLI browser login, "mine" filters, commit trailers | A team on one instance |
| 3. Credential broker | Connections, team and personal model credentials with override, proxy injection or base-URL rewrite, K8s proxy hop, raw keys removed from sandbox env | `env` inside a run shows no secrets |
| 4. MCP gateway | MCP connections, agent profiles with tool allowlists, tool-call audit on run detail | Governed tools |
| 5. Attribution | Cost by principal and connection, per-principal budgets at admission, audit-log extension keyed by subject | The spend view a CTO asks for first |

Two side tracks attach without blocking:

- **Warren as an MCP server** (`mcp-server.md`). After phase 1, each
  engineer's editor holds a personal token, which is the promotion
  trigger that record names.
- **Retry and fork.** A new run with a parent link, the same or an
  edited manifest, and a compare view. Dispatch onto an existing
  branch shipped in v0.19.1. After phase 1, a retry records who
  retried.

## 9. Policy impact

This record changes these documents when promoted. None of the
changes happen in this commit.

- **ROADMAP.** Rewrite "The direction." Retire the mirror pilot from
  `now`. Promote the auth widening out of "Deferred until paid."
  Remove "MCP server management" and "Per-user spend budgets" from
  "Deliberately not in core," with a pointer here. Amend the
  2026-08-03 decisions as §5 says.
- **External-repository mirror pilot record.** Move to `retired`.
  `warren-experiments` stays as history.
- **Corpus flywheel §0.** Amend the "Warren is not a product"
  positioning.
- **PHILOSOPHY.** No change. "One deploy serves one team" and "no
  multi-tenant SaaS" hold. `ServerDeps` must not grow: the principal
  store, the grant signer, and the broker register through seams.
- **SECURITY.md.** Replace the single-user posture with the principal
  model and the broker threat model.

## 10. Risks

- **TLS interception is a sharp tool.** A per-run CA inside the
  sandbox must never trust anything outside that run. Prefer base-URL
  rewrite. Intercept only bound hosts.
- **Encrypted credential storage makes Warren a target.** The
  deployment key is the root. Document rotation from day one.
- **GitHub as the only IdP** excludes teams that do not use GitHub.
  The Forge seam already supports Azure DevOps. OIDC is the answer
  when such a team appears. An auth proxy covers the gap until then.
- **Scope creep toward RBAC.** Three roles and instance-wide scope are
  the design. A request for more is a new record, not a flag.
- **Harness compliance.** A harness that ignores `HTTP_PROXY` or pins
  certificates defeats injection. The adapter declares which delivery
  paths it supports, as a capability flag (PHILOSOPHY rule 7).

## 11. Open questions

1. Sidecar proxy or control-plane egress gateway for K8s and Docker
   (§6.2).
2. Does a personal Claude subscription meet its provider terms when a
   shared control plane drives it for its owner only? Verify before
   phase 3 ships that path.
3. Should connections that belong to a project (a project's own
   staging database, for example) exist, or do team and personal
   cover it?
4. Where do agent profiles live? The database holds runtime state
   only (ROADMAP decision). Options: git-tracked
   `.warren/agents/*.yaml` with UI edits that open a pull request, or
   an amendment that lets deployment configuration live in the
   database.
5. How long do sessions live, and does a role change end live
   sessions at once?
