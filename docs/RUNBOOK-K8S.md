# Warren on Kubernetes — Operations Runbook

Operator playbook for running warren's **K8sProvider** topology: the control
plane as a `Deployment`, each agent run as its own pod. This is the durable
operations document — deploy, secrets, RBAC, garbage collection, admission
control, observability, and incident response.

**Scope.** This runbook is the `WARREN_RUNTIME=k8s` topology only. For the
default self-host topology (one container, burrow-backed `LocalProvider`) see
the [README](../README.md) quickstart — that path needs none of this.

**Cross-references (read these, don't duplicate them here):**

- [`deploy/k8s/README.md`](../deploy/k8s/README.md) — the manifest **quick
  start**: `kubectl apply -k`, overlay layout, secret creation commands, the
  host-mode kubeconfig-401 workaround. This runbook links into it rather than
  restating it.
- [`docs/deploy/gke-deploy-prep.md`](deploy/gke-deploy-prep.md) — the live
  GKE Autopilot provisioning session (warren-4e36); GCP project, region,
  Supabase pooler gotchas. Scratch material that seeds §1 below.
- [`docs/design/k8s-migration.md`](design/k8s-migration.md),
  [`k8s-migration-plan.md`](design/k8s-migration-plan.md),
  [`runtime-provider-contract.md`](design/runtime-provider-contract.md) — the
  architecture decisions behind everything here.

---

## 0. The runtime-provider model in one paragraph

Warren selects its run backend once at boot from `WARREN_RUNTIME`
(`src/runtime/registry.ts`): unset/`local` → the burrow-backed `LocalProvider`
(the self-host default); `k8s` → the `K8sProvider`. Both implement the same
eight-method `RuntimeProvider` contract (`src/runtime/contract.ts`), so the
domain (`src/runs/*`) is identical across topologies — only workspace
materialization, event streaming, steering transport, and finalize differ.
Under `k8s` **there is no burrow**: no `burrow serve` sibling, no unix socket,
no bwrap. Each run is a bare pod (`restartPolicy: Never`) in the `warren-runs`
namespace; the pod boundary is the sandbox. A bad `WARREN_RUNTIME` value fails
loud at boot (`UnknownRuntimeError`) — it never silently falls back.

Key consequence for operators: everything burrow-shaped in the self-host docs
(the four bwrap security flags, `BURROW_API_TOKEN`/`WARREN_BURROW_TOKEN`,
`BURROW_DATA_DIR`, the supervisor) is **dead weight under `k8s`** and must not
be set — see §2.4.

---

## 1. Deploy

### 1.1 Hosted target — GKE Autopilot

Autopilot is the reference hosted target (deployed live 2026-07-13, warren-4e36).
Autopilot manages nodes, bills per-pod requests, and enforces restricted
PodSecurity — which the pod-spec builder (`src/runtime/k8s/pod-spec.ts`) already
complies with (non-root uid 1000, `drop: [ALL]`, `seccompProfile:
RuntimeDefault`, no privilege escalation, `restartPolicy: Never`).

One-time provisioning (full command set in
[`gke-deploy-prep.md`](deploy/gke-deploy-prep.md) §2):

```bash
export PROJECT_ID=...  REGION=us-west1  CLUSTER=warren
export AR=${REGION}-docker.pkg.dev/${PROJECT_ID}/warren

gcloud services enable container.googleapis.com artifactregistry.googleapis.com
gcloud artifacts repositories create warren --repository-format=docker --location=${REGION}
gcloud auth configure-docker ${REGION}-docker.pkg.dev
gcloud container clusters create-auto ${CLUSTER} --region=${REGION} --release-channel=regular
gcloud container clusters get-credentials ${CLUSTER} --region=${REGION}
```

Autopilot gotchas that bite:

- **Autopilot raises requests to equal limits.** The builder emits requests
  cpu 1 / mem 2Gi, limits cpu 4 / mem 4Gi. Autopilot admits the pod at
  4 cpu / 4Gi *requests* — that is what you pay for. Verify admitted specs on
  the first run (`kubectl -n warren-runs get pod <run> -o yaml | grep -A6
  resources`); if the cost matters, set per-project `resources` so
  request==limit intentionally (`.warren/config.yaml`, see
  `src/warren-config/resources-config.ts`).
- **Apple Silicon → amd64.** Autopilot schedules amd64. Build all three images
  with `docker buildx build --platform linux/amd64` or they CrashLoop with
  `exec format error`.

### 1.2 Three images

The manifests reference tags only; you build + push them separately. Helper:
`deploy/docker/build-images.sh` (see
[`deploy/k8s/README.md`](../deploy/k8s/README.md) for `--load-k3d` / `--load-kind`
/ `--only`).

| Image | Env var | Dockerfile | Role |
|---|---|---|---|
| `warren` (control plane) | referenced by the Deployment | root `Dockerfile` | boots `warren serve` directly (Deployment overrides ENTRYPOINT away from the supervisor — no burrow child under k8s) |
| `warren-agent` | `WARREN_K8S_AGENT_IMAGE` (default `warren-agent:latest`) | `deploy/docker/Dockerfile.agent` | the run pod's toolchain: bun, node, git, the coding-agent CLIs + os-eco CLIs; runs `bun run agent:run` (`src/runtime/k8s/agent-entrypoint.ts`) |
| `warren-workspace-init` | `WARREN_K8S_INIT_IMAGE` (default `warren-workspace-init:latest`) | `deploy/docker/Dockerfile.workspace-init` | lightweight bun+git init container; runs `bun run workspace:init` (`src/runtime/k8s/workspace-init.ts`) |

The `:latest` defaults are unqualified — the Deployment **must** set
`WARREN_K8S_AGENT_IMAGE` / `WARREN_K8S_INIT_IMAGE` to fully-qualified registry
paths or the cluster has nothing to pull. Pinned digests recommended on GKE.

### 1.3 Apply the manifests

Everything is kustomize; pick an overlay. Full detail (secret creation, overlay
differences, ingress notes) lives in
[`deploy/k8s/README.md`](../deploy/k8s/README.md) — do not re-derive it here.

```bash
kubectl apply -k deploy/k8s/overlays/gke     # GKE Autopilot
kubectl apply -k deploy/k8s/overlays/kind    # local kind / k3d dev
```

The base creates two namespaces (`warren` control plane, `warren-runs` run
pods), a ServiceAccount, the RBAC Role/RoleBinding (§4), a ResourceQuota +
LimitRange, PVCs (`warren-data` 5Gi, `warren-repo-cache` 50Gi), the Deployment,
Service, and Ingress. `servicemonitor.yaml` is applied separately (needs the
Prometheus Operator CRD).

### 1.4 Local dev (kind / k3d)

The `overlays/kind` overlay pins `imagePullPolicy: Never` (load images into the
node first), nginx ingress, and a shrunk repo-cache PVC. One caveat that will
waste an afternoon: running the **control plane on your host** against a k3d/kind
cluster hits an **HTTP 401 on every K8s API call** — Bun's `fetch` can't present
the kubeconfig client cert against the self-signed cluster CA. In-cluster
ServiceAccount bearer-token auth (the production path) is unaffected. Two
workarounds (`kubectl proxy`, or a token kubeconfig with
`--insecure-skip-tls-verify`) are documented in full in
[`deploy/k8s/README.md`](../deploy/k8s/README.md) under "Host-mode local dev".

### 1.5 Database — Postgres in practice

Nothing in code *forces* Postgres under `k8s` (`run_inbox` has both a sqlite and
a postgres migration), but SQLite on a `ReadWriteOnce` PVC is a single-replica
trap. Set `WARREN_DB_URL=postgres://...` deliberately. Supabase pooler gotchas
(the `sslmode=require&uselibpqcompat=true` compat flag; IPv6-only direct host vs.
IPv4 session pooler on Autopilot) are in
[`gke-deploy-prep.md`](deploy/gke-deploy-prep.md) §5. Agent run pods never get
the DB URL — only the control plane does (§3, blast-radius minimization).

### 1.6 Automated CI/CD (GitHub Actions)

`.github/workflows/deploy-gke.yml` automates §1.2 (build + push) and §1.3
(apply) so a GKE roll-forward never needs `build-images.sh` +
`kubectl apply -k` by hand (warren-bd79). The manual flow above stays the
break-glass fallback (and the only path for kind/k3d local dev, §1.4).

- **Build + push** (`build-push` job) runs on every push to `main`, on a
  published release, and on manual dispatch. It builds all three images
  (`Dockerfile` → `warren`, `deploy/docker/Dockerfile.agent` →
  `warren-agent`, `deploy/docker/Dockerfile.workspace-init` →
  `warren-workspace-init`) with `docker buildx --platform linux/amd64`
  (Autopilot is amd64; arm64 CrashLoops with `exec format error`), tags
  each by the full commit SHA **and** `latest`, and pushes to the same
  `<region>-docker.pkg.dev/<project>/<repo>` Artifact Registry that
  `cloudbuild.yaml` targets. Layer cache is GHA-scoped per image.
- **Deploy** (`deploy` job) runs on a published GitHub release **or** a
  manual dispatch that ticks the `deploy` input. A bare push to `main`
  only builds images — it never touches the cluster. The job pulls cluster
  credentials (`get-gke-credentials`), then renders the gitignored
  `gke-live` overlay *on the runner* (never committed — see `.gitignore`),
  layering on the committed `gke` template and pinning all three images to
  the commit SHA (control-plane image via kustomize `images:`, agent + init
  images via the Deployment env patch), before `kubectl apply -k` and a
  `rollout status` gate. This is exactly the documented `gke-live` pattern
  (`deploy/k8s/overlays/gke/kustomization.yaml` header), produced from CI
  vars instead of a hand-maintained local overlay.

Auth is **GCP Workload Identity Federation** (`google-github-actions/auth`)
— no long-lived JSON service-account keys. A repo admin must configure:

| Kind | Name | Meaning |
|---|---|---|
| secret | `GCP_WORKLOAD_IDENTITY_PROVIDER` | full WIF provider resource (`projects/<num>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`) |
| secret | `GCP_SERVICE_ACCOUNT` | deployer SA email; needs `roles/artifactregistry.writer` + `roles/container.developer` and a WIF binding to this repo |
| var | `GCP_PROJECT_ID` | GCP project (e.g. `warren-502318`) — **required** |
| var | `GCP_REGION` | Artifact Registry / cluster region (default `us-west1`) |
| var | `GCP_AR_REPO` | Artifact Registry repo name (default `warren`) |
| var | `GKE_CLUSTER` | Autopilot cluster name (default `warren`) |
| var | `GKE_LOCATION` | cluster location (default `GCP_REGION`) |
| var | `WARREN_GIT_AUTHOR_EMAIL` | agent-commit author (`<id>+warren@users.noreply.github.com`); defaults to a noreply address if unset |
| var | `WARREN_INGRESS_HOST` | optional public hostname; when set, patches the Ingress host + ManagedCertificate domain (both placeholders in the committed template) |

This is the only deploy pipeline: a published GitHub release (cut by
`release.yml`) triggers the `release: [published]` path here, which
builds the SHA-pinned images and rolls the cluster forward. There is no
Fly.io deploy (removed in warren-b65c).

---

## 2. Secrets

### 2.1 What exists and where

Two namespaces hold secrets, because the run namespace is deliberately isolated
from the control plane's credential set.

| Secret / key | Namespace | Consumed as | Purpose |
|---|---|---|---|
| `warren-secrets/warren-api-token` | `warren` | `WARREN_API_TOKEN` | bearer auth on every route except `/healthz`; also the in-pod callback token and the preview-cookie HMAC seed |
| `warren-secrets/warren-db-url` | `warren` | `WARREN_DB_URL` | Postgres DSN (omit → SQLite on `warren-data`) |
| `warren-secrets/github-token` | `warren` | `GITHUB_TOKEN` | control-plane git push / private clone |
| `warren-secrets/anthropic-api-key` | `warren` | `ANTHROPIC_API_KEY` | injected into agent pod env at dispatch |
| `warren-secrets/sentry-dsn` | `warren` | `SENTRY_DSN` | error reporting (optional) |
| `warren-git-token/token` | `warren-runs` | `WARREN_GIT_TOKEN` (init pod) | init-container clone/push; **optional** — public repos clone without it, private repos **fail silently** if it is missing |
| `warren-anthropic-key/api-key` | `warren-runs` | agent pod `secretKeyRef` | OPTIONAL agent key source (`WARREN_K8S_ANTHROPIC_SECRET_NAME`/`_KEY`); a run whose key rides the dispatch env still schedules when this Secret is absent |

`base/secrets.yaml` ships **placeholder templates** so `kustomize build`
resolves — never `kubectl apply` it as-is. Create secrets imperatively; the exact
`kubectl create secret generic` commands are in
[`deploy/k8s/README.md`](../deploy/k8s/README.md) ("Secrets — never commit real
values").

### 2.2 The `warren-runs` isolation boundary

Run pods receive only what a compromised pod is allowed to hold: the Anthropic
key (agent), `WARREN_API_TOKEN` (callback), `WARREN_GIT_TOKEN` (init clone/push).
They do **not** get the DB URL, and they cannot read Secrets from the K8s API —
the RBAC Role grants no `secrets` verb (§4). Secrets reach pods as env the
control plane stamps into the pod spec, not as API reads by the pod.

### 2.3 Rotation

There is one bearer token and it is not scoped or versioned (SPEC §11.D).

- **`WARREN_API_TOKEN`.** Rotating it invalidates in-flight callback auth and
  every preview cookie (the HMAC key is derived from it). Rotate during a quiet
  window: update `warren-secrets`, `kubectl -n warren rollout restart
  deploy/warren`. In-flight run pods holding the old token in their env will
  fail their finalize callback — drain first (§7.6) or accept that active runs
  reap degraded.
- **`GITHUB_TOKEN` / `WARREN_GIT_TOKEN`.** Update both copies (control-plane
  `warren-secrets/github-token` and run-namespace `warren-git-token/token` are
  the same PAT by convention). Rollout-restart the control plane; new run pods
  pick up the new value at next dispatch. Old pods keep the token baked into
  their spec until they terminate.
- **`ANTHROPIC_API_KEY`.** Update `warren-secrets` (control-plane env source) and
  the optional `warren-anthropic-key` if you use the `secretKeyRef` path.
  Rollout-restart.

Rotation is coarse (edit Secret, restart) because V1 has no token expiry/scopes;
per-user identity and short-lived per-run GitHub App tokens are roadmap (R-09,
R-18).

### 2.4 Secrets you must NOT set under k8s

`BURROW_API_TOKEN`, `WARREN_BURROW_TOKEN`, `BURROW_DATA_DIR`, and the four bwrap
security overrides are LocalProvider-only. They are not read under
`WARREN_RUNTIME=k8s`; carrying them into the cluster is confusing dead weight.
Do not `--from-env-file` a self-host `.env` straight into `warren-secrets` —
cherry-pick the keys in the table above.

---

## 3. Control-plane configuration (env)

The Deployment env that turns on and tunes the K8s backend. Manifest values live
in `deploy/k8s/base/deployment.yaml` + the overlays; the full Fly→K8s mapping is
in [`gke-deploy-prep.md`](deploy/gke-deploy-prep.md) §4.

| Env | Value / default | Meaning |
|---|---|---|
| `WARREN_RUNTIME` | `k8s` | selects `K8sProvider` (default `local`) |
| `WARREN_K8S_NAMESPACE` | `warren-runs` | namespace run pods land in |
| `WARREN_K8S_AGENT_IMAGE` / `WARREN_K8S_INIT_IMAGE` | registry paths | the run pod + init images (§1.2) |
| `WARREN_K8S_CALLBACK_SERVICE` / `_NAMESPACE` / `_PORT` | `warren` / `warren` / `8080` | the in-pod callback URL = Service DNS `warren.warren.svc.cluster.local:8080` (provider-owned; do not set `WARREN_API_URL` by hand) |
| `WARREN_K8S_REPO_CACHE_PVC` | (set in deployment) | names the shared repo-cache claim; clear to disable the cache (every run clones fresh) — see §5.3 |
| `WARREN_K8S_REPO_CACHE_PATH` | `/repo-cache` | mount path for the cache |
| `WARREN_K8S_MAX_QUEUE_DEPTH` | `50` | admission: total non-terminal pods; `0` disables (§5.5) |
| `WARREN_K8S_MAX_PENDING_PODS` | `20` | admission: Pending pods; `0` disables |
| `WARREN_K8S_MAX_PROJECT_CONCURRENCY` | unset (unlimited) | admission: global per-project default |
| `WARREN_K8S_ANTHROPIC_SECRET_NAME` / `_KEY` | `warren-anthropic-key` / `api-key` | optional agent-key `secretKeyRef` |
| `WARREN_K8S_GIT_SECRET_NAME` / `_KEY` | `warren-git-token` / `token` | init-container git token source |

Provider-injected into pods (never set by hand): `WARREN_API_URL`,
`WARREN_RUN_ID`, `WARREN_REPO_URL`, `WARREN_BRANCH`, `WARREN_BASE_BRANCH`,
`WARREN_WORKSPACE_PATH`, `WARREN_SEED_MANIFEST`.

---

## 4. RBAC — what the Role grants and why

The control-plane ServiceAccount (`warren` in namespace `warren`) gets a `Role` +
`RoleBinding` in `warren-runs` **only** — no ClusterRole, no cluster-wide grant
(`deploy/k8s/base/rbac.yaml`; design Q4 / R5). Verbs are exactly what
`src/runtime/k8s/` exercises:

| Resource | Verbs | Why |
|---|---|---|
| `pods` | `get, list, watch, create, delete` | dispatch (create), the pod-watcher informer (list/watch), status reads (get), reap + GC (delete) |
| `pods/log` | `get, watch` | the pod-log NDJSON event stream (§6.1 / §5.1) |
| `configmaps` | `get, list, create, delete` | per-run seed-file ConfigMaps — create at dispatch, list/delete at GC |

Deliberately **absent**: no `update`/`patch` (warren replaces, never mutates in
place), no `secrets` read (agent secrets are injected as pod env by the control
plane, never read from the API by run pods — this is the §2.2 blast-radius
boundary). Verify on any cluster:

```bash
kubectl auth can-i --as=system:serviceaccount:warren:warren \
  create pods -n warren-runs          # → yes
kubectl auth can-i --as=system:serviceaccount:warren:warren \
  get secrets -n warren-runs          # → no
kubectl auth can-i --as=system:serviceaccount:warren:warren \
  create pods -n default              # → no (namespace-scoped)
```

If dispatch fails with a `403 Forbidden` from the K8s API, this Role is the first
thing to check — a missing verb (commonly `configmaps` or `watch`, which the
plan text under-specified) manifests as pods never being created or the informer
never attaching.

---

## 5. Garbage collection & resource growth

Three things accumulate and each has its own reaper. Left unbounded they exhaust
the namespace quota (§5.4) or the cache PVC.

### 5.1 Pod GC loop (terminal pods + seed ConfigMaps)

`src/runtime/k8s/pod-gc.ts`, booted alongside the pod-watcher under k8s
(`src/server/main/runtime-wiring.ts`). Bare pods with `restartPolicy: Never` are
never reaped by K8s itself, and **pod logs — the event stream's durable store —
are retained only until the pod is deleted**. The loop:

- sweeps every **5 min** (`DEFAULT_GC_INTERVAL_MS`);
- deletes pods in `Succeeded`/`Failed` phase older than **30 min**
  (`DEFAULT_GC_MAX_AGE_MS`, design R6), aged off the latest container
  `terminated.finishedAt` (falls back to `creationTimestamp`);
- then deletes any run-labelled ConfigMap whose run-id is not backed by a kept
  pod — reclaiming both the just-deleted pods' seed ConfigMaps and truly orphaned
  ones;
- is best-effort: a single delete failure is logged and skipped, never wedging
  the sweep. `warren_pod_gc_deletions_total{resource}` counts reclaims.

Implication: **a run's events are only queryable from the pod log for ~30 min
after it finishes** — but they are already persisted into warren's events table
by the log-follow bridge during the run, so the durable record survives GC. If
you need the raw pod around longer for forensics, `kubectl -n warren-runs get pod
<run> -o yaml` before the window closes, or lengthen the window in code.

### 5.2 `never_started` row GC (scheduler retry hygiene)

A persistently-unreachable runtime used to mint one `never_started` run row per
60s cron tick forever (~200 rows in 3h observed on GKE, warren-a0a2). The bounded
cron-retry tracker (`src/triggers/cron-retry.ts`) now caps consecutive transient
spawn failures at **5 per slot** (`MAX_CRON_TRANSIENT_RETRIES`, ≈ a 5-min outage
window), then consumes the slot and emits `scheduler.cron_gave_up`. Each failed
attempt GC's the previous attempt's `never_started` row, so at most one such row
survives per failed slot. This is in-memory state — a control-plane restart
resets the counters (acceptable: worst case is one extra bounded burst after a
restart).

### 5.3 Repo-cache growth

`warren-repo-cache` (50Gi RWO) is a **shared clone cache**, never a working tree
(the working tree is the per-pod `emptyDir`). When `WARREN_K8S_REPO_CACHE_PVC`
names it, the init container keeps a per-repo bare mirror
(`<sha256(url)>.git`, `git clone --mirror` then `git fetch` on reuse) at
`/repo-cache`, so a run is a `git fetch` + fast local clone instead of a full
network clone (warren-e908, design §4.3 / R2). Growth is bounded by the number
of distinct repos × their object-store size, not by run count. If it fills:
expand the PVC, or clear `WARREN_K8S_REPO_CACHE_PVC` to disable caching (runs
then clone fresh — slower, no disk growth). A wedged/corrupt mirror never blocks
a run: any cache failure falls back to a direct network clone automatically (see
§7.5).

### 5.4 Namespace quota (the hard backstop)

`warren-runs` carries a `ResourceQuota` (50 pods; 100 CPU / 200Gi requests,
200 CPU / 200Gi limits) plus a paired `LimitRange` (`warren-runs-defaults`). The
LimitRange is load-bearing, not decorative: a compute ResourceQuota rejects any
pod whose containers don't **all** declare requests+limits, and the
`workspace-init` container declares none — the LimitRange supplies its defaults
so the pod admits. If you keep the quota, keep the LimitRange, or every dispatch
fails with `must specify requests.cpu`. This quota is the hard ceiling behind
warren's soft admission caps (§5.5).

### 5.5 Admission control knobs

Soft controls in front of the scheduler (`src/runtime/k8s/admission.ts`, design
§3.3), evaluated in `K8sProvider.create()` before any pod write. Counts come off
the pod-watcher snapshot (the pods *are* the queue — no runs-table read). A
rejection throws `RuntimeAdmissionError` → **HTTP 429** + `Retry-After: 30`, with
a machine-readable `reason`. Checks run most-specific-first:

| Reason | Knob (default) | Trips when |
|---|---|---|
| `project_concurrency_exceeded` | `.warren/config.yaml` `admission.maxConcurrentRuns`, else `WARREN_K8S_MAX_PROJECT_CONCURRENCY` (unlimited) | the dispatching project already has ≥ cap non-terminal run pods |
| `cluster_pending_saturated` | `WARREN_K8S_MAX_PENDING_PODS` (20) | ≥ cap run pods stuck `Pending` (cluster can't schedule what it has) |
| `queue_depth_exceeded` | `WARREN_K8S_MAX_QUEUE_DEPTH` (50) | ≥ cap total non-terminal run pods |

Set any knob to `0` to disable that cap. `warren_run_admission_rejections_total
{reason}` makes rejections observable.

---

## 6. Observability

### 6.1 Prometheus metrics

Warren exposes `GET /metrics` (bearer-auth). K8s-specific families
(`src/runtime/k8s/pod-metrics.ts`, wired via the pod-watcher) — apply
`deploy/k8s/servicemonitor.yaml` on clusters running the Prometheus Operator
(kept out of the kustomize base because it needs the `monitoring.coreos.com/v1`
CRD):

| Metric | Type | Alert-worthy signal |
|---|---|---|
| `warren_run_oom_killed_total` | counter | rising ⇒ agent memory limits too low, or a runaway prompt |
| `warren_run_evicted_total` | counter | rising ⇒ pods evicted under node pressure, usually ephemeral-storage exhaustion (§7.3.1) — raise `resources.limits.ephemeralStorageMiB` |
| `warren_run_pod_phase{phase}` | gauge | a growing `Pending` series ⇒ cluster can't schedule (pairs with `cluster_pending_saturated`) |
| `warren_pod_pending_duration_seconds` | gauge | age of the longest-pending pod; sustained high ⇒ scheduling starvation |
| `warren_workspace_init_duration_seconds` | gauge | last clone time; spikes ⇒ cold cache / slow git |
| `warren_pod_watch_reconnects_total` | counter | frequent reconnects ⇒ flaky API-server watch |
| `warren_workspace_init_failures_total` | counter | rising ⇒ clone/materialize failures (bad token, unreachable origin) |
| `warren_pod_log_parse_failures_total` | counter | occasional is normal (stray agent stdout); a flood ⇒ malformed event stream |
| `warren_pod_gc_deletions_total{resource}` | counter | should track completed runs; flatline while pods pile up ⇒ GC wedged (§7) |
| `warren_run_admission_rejections_total{reason}` | counter | rising ⇒ hitting an admission cap (§5.5) |

(The two `_duration_seconds` render as gauges, not histograms — warren's
dependency-free metrics core exposes only gauge+counter.)

### 6.2 `/readyz` per topology

`GET /readyz` (`src/server/handlers/diagnostics.ts`) runs deeper checks than the
liveness `/healthz`. It is **topology-aware**: the burrow socket, bwrap, and
stale-burrow-workspace probes are gated on `resolveRuntimeKind() === "local"` and
return `[]` under k8s (warren-c128) — otherwise they'd forever report "burrow
unreachable" and wrongly degrade a healthy K8s control plane. Under k8s,
`/readyz` covers: DB reachable, agents registered, canopy clone (when
`CANOPY_REPO_URL` set), warren-config parse, and preview-allocator/auth checks.

Deployment probes point at the **auth-exempt `/healthz`**; `/readyz` requires the
bearer, so gate readiness on it only via a probe `httpHeaders: [{name:
Authorization, value: "Bearer …"}]`. Use `/readyz` for deploy gating, not
hot-path liveness.

### 6.3 Structured log events worth alerting on

One pino JSON line per event on stdout (`kubectl -n warren logs deploy/warren |
jq`). Alert on these:

- **`scheduler.cron_gave_up`** (error level) — a cron slot burned all 5 retries
  against an unreachable runtime and gave up (§5.2). Persistent recurrence means
  the K8s backend is unreachable or misconfigured; investigate before every cron
  trigger silently stops firing.
- **`reap.pr_open_context_degraded`** — under k8s the PR body's
  commits/files-changed sections are rebuilt by fetching the pushed run branch
  into the project clone under a temp ref (`refs/warren/pr-open/<runId>`,
  warren-ab66). This fires when that fetch fails; the PR still opens but with
  empty commit/diff sections. Occasional is tolerable; sustained ⇒ the project
  clone can't fetch the run branch (token/network).
- **`reap.preview_skipped_unsupported`** — a project shipped `.warren/preview.yaml`
  but the K8s provider has `previewPorts: false` (previews via Service/Ingress
  are deferred), so no preview launched. Expected on k8s; alert only if it
  surprises you (someone expected previews on this topology).

### 6.4 First triage commands

```bash
kubectl -n warren get pods                              # control plane Ready?
kubectl -n warren logs deploy/warren --tail=200 | jq
kubectl -n warren-runs get pods -l warren.io/run-id     # run pods + phases
kubectl -n warren-runs describe pod <run>               # events: scheduling, OOM, pull errors
```

---

## 7. Incident response playbooks

Symptom → diagnosis → remedy. Each grounded in verified behavior.

### 7.1 Runtime unreachable — dispatches fail, `scheduler.cron_gave_up` recurs

**Symptom.** New runs never start; cron triggers log `scheduler.cron_gave_up`
every slot; manual dispatch returns a 5xx or hangs.

**Diagnose.** Is it the K8s API or the control plane?
```bash
kubectl -n warren logs deploy/warren --tail=200 | jq 'select(.level >= 50)'
kubectl auth can-i --as=system:serviceaccount:warren:warren create pods -n warren-runs
```
A `403` ⇒ RBAC regression (§4). A `401` off-cluster ⇒ the Bun-fetch client-cert
issue (host-mode only, §1.4) — not possible for an in-cluster pod. Connection
errors ⇒ API server unreachable / kubeconfig wrong.

**Remedy.** Fix the RBAC binding or the kubeconfig/ServiceAccount mount, then
`kubectl -n warren rollout restart deploy/warren`. The cron-retry backoff means
triggers resume on their next slot once the runtime recovers — no manual
replay needed.

### 7.2 Pod stuck `Pending`

**Symptom.** A run sits `queued`/`running` in warren; its pod is `Pending`;
`warren_pod_pending_duration_seconds` climbs; new dispatches start returning
`429 cluster_pending_saturated`.

**Diagnose.**
```bash
kubectl -n warren-runs describe pod run-<id>   # Events section is authoritative
```
Common causes: insufficient cluster capacity for the requests (Autopilot is
scaling up nodes — wait), the ResourceQuota is exhausted (§5.4), the image can't
be pulled (`ErrImagePull` — wrong registry path or missing pull creds), or the
LimitRange was dropped so the init container has no requests (`must specify
requests.cpu`).

**Remedy.** Capacity → wait or raise the quota. Quota exhausted → the pod GC
(terminal pods clearing at 30 min) frees slots; or raise the quota; the admission
429 is protecting the cluster, honor the `Retry-After`. Image pull → fix
`WARREN_K8S_AGENT_IMAGE`/`_INIT_IMAGE` to a pullable ref. LimitRange → re-apply
`resourcequota.yaml`.

### 7.3 OOMKilled runs

**Symptom.** A run flips to `failed` within seconds; `warren_run_oom_killed_total`
increments; `describe pod` shows `Last State: Terminated, Reason: OOMKilled`.

**Diagnose.** This is fast-fail working as designed — kubelet killed the
container at its `memory.limit`, the pod-watcher saw
`terminated.reason == OOMKilled` in ~1-2s and marked the run `failed
(oom_killed)`. The question is whether the limit is too low or the run is a
genuine runaway. Check the prompt/workload against the 4Gi default limit.

**Remedy.** For legitimately heavy runs, raise the per-project memory limit
(`.warren/config.yaml` resources; `src/warren-config/resources-config.ts`) so
request/limit fit the workload; on Autopilot remember request==limit billing. For
a runaway, fix the agent/prompt — do not paper over it by raising limits cluster-
wide. Note there is no blind retry: `restartPolicy: Never` means an OOM ends the
pod, warren surfaces the failure immediately rather than re-running from scratch.

#### 7.3.1 Evicted runs (ephemeral-storage exhaustion)

**Symptom.** A run flips to `failed (evicted)`; `warren_run_evicted_total`
increments; `describe pod` shows `Status: Failed`, `Reason: Evicted`, message
`Pod ephemeral local storage usage exceeds the total limit of containers …`,
and a container `Terminated, Reason: ContainerStatusUnknown, Exit Code: 137`.

**Diagnose.** The agent's `/workspace` (an emptyDir carrying the clone + `bun
install`) outgrew the pod's ephemeral-storage budget and the kubelet reclaimed
the pod. The `Evicted` pod reason — not the container's `ContainerStatusUnknown`
code — is the reliable witness (`src/runtime/k8s/status-map.ts`), so the run
finalizes `failed (evicted)` rather than a generic error. **On GKE Autopilot a
pod with NO explicit ephemeral-storage request is injected a 1Gi default**, which
a real clone + install blows past in minutes; warren now sets an explicit 10Gi
request+limit on BOTH the agent and workspace-init containers plus a matching
emptyDir `sizeLimit` (warren-653f), so the default budget is generous.

**Remedy.** For a legitimately large repo/toolchain, raise the ephemeral-storage
budget in `.warren/config.yaml`:

```yaml
resources:
  requests:
    ephemeralStorageMiB: 20480   # 20 GiB
  limits:
    ephemeralStorageMiB: 20480   # request == limit (Autopilot forces it)
```

Bounds are 64 MiB..1 TiB (`src/warren-config/resources-config.ts`). Absent, the
`DEFAULT_K8S_EPHEMERAL_STORAGE_*_MIB` 10Gi default applies. On Autopilot the
pod-level ephemeral-storage limit is the SUM of the container limits, so both
containers carrying 10Gi gives a 20Gi pod budget with the emptyDir itself capped
at the per-container limit for a crisp "workspace too big" signal.

### 7.4 Admission 429s

**Symptom.** Dispatch returns `429` with `Retry-After: 30` and a `reason`.

**Diagnose.** Read the `reason` (§5.5): `project_concurrency_exceeded` (one
project saturated its own cap), `cluster_pending_saturated` (too many Pending
pods cluster-wide), or `queue_depth_exceeded` (total non-terminal pods hit the
ceiling). Cross-check `warren_run_admission_rejections_total{reason}` and the
`warren_run_pod_phase{phase}` gauges.

**Remedy.** These are working as intended — a soft control shedding load before
the cluster thrashes. If the cap is genuinely too tight for your capacity, raise
the corresponding knob (§3 env, or per-project `admission.maxConcurrentRuns`) and
rollout-restart. If it's `cluster_pending_saturated`, the real fix is scheduling
capacity (§7.2), not a higher cap. Clients should honor `Retry-After` and back
off.

### 7.5 Repo-cache corruption

**Symptom.** Init containers log clone/fetch failures against `/repo-cache`;
`warren_workspace_init_failures_total` rises; but runs may still complete (slower).

**Diagnose.** The cache is best-effort — a corrupt bare mirror
(`/repo-cache/<sha256(url)>.git`) makes the init container fall back to a direct
network clone, so a wedged mirror **degrades latency, not correctness**. Confirm
via the init container log:
```bash
kubectl -n warren-runs logs run-<id> -c workspace-init
```

**Remedy.** Exec into a pod that mounts the PVC (or a debug pod) and delete the
bad mirror directory; the next run re-mirrors it clean. Or clear
`WARREN_K8S_REPO_CACHE_PVC` to disable caching entirely (all runs clone fresh)
while you investigate. Because RWO pins the cache to one node, corruption is
single-node-scoped today.

### 7.6 Draining the control plane for maintenance

There is no in-flight-run migration (single control-plane replica; SSE sessions
are sticky). To take the control plane down cleanly: pause dispatch (stop the
scheduler — e.g. `WARREN_PLAN_RUN_DISABLED=1` and remove cron triggers, or accept
the bounded cron-retry backoff), let active run pods finish (watch `kubectl -n
warren-runs get pods`), then `rollout restart`. Run pods are independent of the
control-plane pod — they keep running across a control-plane restart and
reconcile via the pod-watcher when it comes back, but a run that finalizes while
the control plane is down will retry its callback and may reap degraded.

### 7.7 Node failure (single-node clusters)

On a single-node cluster (or when a run pod's node dies), the pod vanishes from
the API without a clean termination event. The reduced **5-min watchdog** (not
the legacy 45-min one) marks the run `failed` once the watch confirms the pod is
gone but the run row is still `running`. The DB (Postgres, external) survives; the
control plane restarts via its Deployment. In-flight runs are lost, not resumed.

### 7.8 Run stuck `running` after its pod completed (reap hang, warren-c433)

Symptom: a run row stays `state=running`, `endedAt=null` long after `kubectl -n
warren-runs get pods` shows the pod `Succeeded`/`Failed`; the last log line is the
run-state poller's "observed burrow terminal; draining stream before abort". Root
cause was a pod-log follow that never EOF'd after the pod exited: the post-terminal
stream teardown parked on `iterator.return()` forever, so reap (and the in-pod
finalize handshake) never fired.

Mitigations now in place:

- The post-terminal stream teardown is **bounded** (`DEFAULT_STREAM_TEARDOWN_MS`,
  5s): a hung pod-log pump can no longer wedge the bridge's path to reap.
- The heartbeat watchdog gained a **terminal-reconcile net**: each tick it probes
  `status()` for a `running` run idle past `WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS`
  (default 2 min; `0` disables). If the pod is terminal-or-gone but the row is still
  `running`, it force-finalizes through reap with the pod's actual outcome — a
  `succeeded` pod re-drives the in-pod finalize (a still-polling pod parks/picks up
  the intent; an already-lapsed one degrades to the documented finalize-timeout
  `FinalizeResult`). This emits a `watchdog.terminal_reconciled` event on the run.

If a run is still wedged: check the control-plane logs for `watchdog reconciled
terminal-but-stuck run`; if the net is disabled (`WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS=0`)
re-enable it, or `kubectl -n warren-runs delete pod <pod>` to force the pod-gone
path.

---

## 8. Capability degradations on k8s (know before you promise)

The K8sProvider does not match every LocalProvider capability. The domain
branches on `RuntimeCapabilities` (`src/runtime/contract.ts`); operators should
know the gaps:

- **Preview environments are off** (`previewPorts: false`). A `.warren/preview.yaml`
  produces no preview and logs `reap.preview_skipped_unsupported`. Service/Ingress
  previews are deferred.
- **Steering latency is ~5s, not real-time.** Steer writes a `run_inbox` row; the
  in-pod agent polls `GET /runs/:id/inbox`. This is a reliability gain (survives
  pod/control-plane restart) at a latency cost vs. the LocalProvider stdin path.
- **Network policy is coarse.** No per-domain allowlist under k8s v1
  (`networkPolicy: "coarse"` vs. LocalProvider's `domain-allowlist`).
- **Repo cache is RWO — single-node only.** `warren-repo-cache` must move to a
  `ReadWriteMany` class (GKE Filestore CSI; Longhorn on bare metal) **before** you
  add a second node, or init containers may schedule where they can't mount it
  (design R2). Do not provision Filestore just to run single-node.

---

## 9. Quick reference

```bash
# Health
kubectl -n warren get deploy,svc,pods
curl -s localhost:8080/healthz                      # via port-forward (auth-exempt)
curl -s -H "Authorization: Bearer $TOK" localhost:8080/readyz | jq
curl -s -H "Authorization: Bearer $TOK" localhost:8080/metrics | grep warren_run

# Run pods
kubectl -n warren-runs get pods -l warren.io/run-id
kubectl -n warren-runs logs run-<id> -c workspace-init      # clone phase
kubectl -n warren-runs logs run-<id>                        # agent NDJSON stream
kubectl -n warren-runs describe pod run-<id>                # scheduling / OOM events

# RBAC sanity
kubectl auth can-i --as=system:serviceaccount:warren:warren create pods -n warren-runs

# Roll the control plane
kubectl -n warren rollout restart deploy/warren
```
