# Warren Kubernetes manifests

Manifests + RBAC for running the warren control plane on Kubernetes with pod-per-run agent sandboxes (design [`docs/design/k8s-migration.md`](../../docs/design/k8s-migration.md) §6.2/§6.3/R5/Q4). The operator runbook is [`docs/RUNBOOK-K8S.md`](../../docs/RUNBOOK-K8S.md). Hosted target is **GKE Autopilot**; everything applies on **kind**/**k3d** for local validation.

## Layout

```
deploy/k8s/
  base/                 controller-/cloud-agnostic manifests (kustomize base)
    namespaces.yaml       warren (control plane) + warren-runs (run pods)
    serviceaccount.yaml   control-plane ServiceAccount
    rbac.yaml             Role + RoleBinding scoped to warren-runs ONLY
    resourcequota.yaml    ResourceQuota (50 pods) + LimitRange defaults
    networkpolicy.yaml    run-pod NetworkPolicy (default-deny ingress + coarse egress)
    secrets.yaml          Secret TEMPLATES (placeholders — do not apply as-is)
    pvc.yaml              warren-data (5Gi) — the repo-cache is opt-in, see below
    deployment.yaml       warren control-plane Deployment
    service.yaml          ClusterIP Service (callback DNS + ingress backend)
    ingress.yaml          controller-agnostic Ingress
    kustomization.yaml
  overlays/
    kind/                 local: nginx ingress, imagePullPolicy Never, small PVC
    gke/                  GKE Autopilot: Artifact Registry images, gce Ingress + static IP,
                          ManagedCertificate TLS, FrontendConfig HTTPS redirect, NEG ClusterIP,
                          BackendConfig (Cloud Armor + stream-safe backend timeout)
  components/
    postgres/             opt-in in-cluster Postgres Component (warren-9f5a), see below
  servicemonitor.yaml     Prometheus Operator scrape (standalone — see below)
```

## Apply

Everything is kustomize; pick an overlay. kustomize orders by kind, so the two
namespaces are created before the objects that land in them — a single command
applies the whole set:

```bash
# local (kind / k3d)
kubectl apply -k deploy/k8s/overlays/kind

# GKE Autopilot (after editing the registry paths in overlays/gke/kustomization.yaml)
kubectl apply -k deploy/k8s/overlays/gke
```

If you apply raw files instead of kustomize, apply in this order: `namespaces` →
(`serviceaccount`, `rbac`, `resourcequota`, `secrets`, `pvc`) → (`service`,
`deployment`, `ingress`).

> `kubectl apply --dry-run=server -k …` reports "namespace not found" for the
> namespaced objects because a server dry-run never actually creates the
> namespaces. That is a dry-run artifact, not a manifest error — a real apply
> succeeds (validated on k3d). Use `kubectl kustomize <overlay>` for offline
> validation.

## Components: opt-in in-cluster Postgres

`deploy/k8s/components/postgres/` is a kustomize **Component** (kind
`Component`, `apiVersion kustomize.config.k8s.io/v1alpha1`).

The bundle holds a StatefulSet (postgres:17, one replica, 10Gi PVC with
`storageClassName` omitted so the GKE default `standard-rwo` binds), a
ClusterIP Service on 5432, and a NetworkPolicy admitting ingress only from
the control-plane pods in `warren`.

A placeholder Secret template (`postgres-credentials`) completes the set,
with the same rules as base/secrets.yaml: never apply it as-is. Nothing in
base or any committed overlay includes the component. Opt in from **your
own** (usually gitignored live) overlay:

```yaml
# deploy/k8s/overlays/<your-overlay>/kustomization.yaml
resources:
  - ../../base
components:
  - ../../components/postgres
```

Then point `warren-secrets/warren-db-url` at
`postgres://warren:<pw>@postgres.warren.svc:5432/warren` with no sslmode flags,
because traffic stays inside the cluster network. Runbook:
`docs/RUNBOOK-K8S.md` §1.5, "In-cluster Postgres".

A backup CronJob layer lands under `deploy/k8s/components/postgres/backup/`
(warren-6db7). Do not run this component in production before that exists.

## Public exposure (GKE) — static IP, TLS, DNS

The gke overlay exposes warren through a GCE external Application LB
(warren-682a): global static IP, `ManagedCertificate` TLS, `FrontendConfig`
HTTP→HTTPS redirect, container-native LB (ClusterIP + NEG). The Ingress `host`
and cert `domains` in the overlay are **placeholders** — patch the real
hostname in your gitignored live overlay (see the template header), never in
the committed tree. One-time setup:

```bash
# 1. Reserve the global static IP the Ingress annotation names.
gcloud compute addresses create warren-ingress --global
gcloud compute addresses describe warren-ingress --global --format='value(address)'

# 2. Point DNS at it BEFORE applying: A record for your hostname → that IP.
#    On Cloudflare the record must be DNS-only (grey cloud) — Google's cert
#    validation fails behind the proxy.

# 3. Provision the Cloud Armor policy the BackendConfig references. Do this
#    BEFORE applying — the reference is inert until the policy exists, and
#    nothing warns you about a missing one (warren-48d3).
deploy/gcp/cloud-armor.sh --project "$PROJECT_ID"

# 4. Apply the live overlay, then watch the cert go Provisioning → Active
#    (typically 15–60 min after DNS resolves).
kubectl -n warren get managedcertificate warren -w
```

Grey-cloud DNS means Cloudflare provides no WAF or rate limiting, so per-IP
rate limiting lives in Cloud Armor instead. Thresholds, the kill switch, and
why the injection WAF rule sets are preview-only are documented in
[`docs/RUNBOOK-K8S.md`](../../docs/RUNBOOK-K8S.md) §1.7.

`/metrics` is bearer-gated like the rest of the API (the ServiceMonitor sends
the token), so nothing operational is publicly scrapeable; `/healthz` (liveness,
`{ok: true}`) and `/version` stay open by design.

## Secrets — never commit real values

`base/secrets.yaml` is a **template with placeholder values** so `kustomize build`
resolves and the key layout is documented. For a real deploy, do **not** apply it;
create the secrets imperatively instead:

```bash
kubectl -n warren create secret generic warren-secrets \
  --from-literal=warren-api-token=<bearer token clients send> \
  --from-literal=warren-db-url=postgres://…            # omit ⇒ SQLite on warren-data \
  --from-literal=github-token=<gh PAT: push + private clone> \
  --from-literal=anthropic-api-key=<sk-ant-…> \
  --from-literal=sentry-dsn=<optional>

# The init container reads WARREN_GIT_TOKEN from THIS secret, in warren-runs.
# The agent container references it too — held by the in-pod harness for the
# salvage-window rescue push and scrubbed from the agent child's env.
# Same value as github-token. Optional — public repos clone without it.
kubectl -n warren-runs create secret generic warren-git-token \
  --from-literal=token=<gh PAT>

# Agent pods read OPENROUTER_API_KEY from THIS secret, in warren-runs.
# Optional — needed only for runs whose provider is `openrouter` (pi harness).
kubectl -n warren-runs create secret generic warren-openrouter-key \
  --from-literal=api-key=<sk-or-…>
```

| Secret / key | Namespace | warren env var | Purpose |
|---|---|---|---|
| `warren-secrets/warren-api-token` | warren | `WARREN_API_TOKEN` | API bearer auth |
| `warren-secrets/warren-db-url` | warren | `WARREN_DB_URL` | Postgres DSN (optional → SQLite) |
| `warren-secrets/github-token` | warren | `GITHUB_TOKEN` | git push / private clone |
| `warren-secrets/anthropic-api-key` | warren | `ANTHROPIC_API_KEY` | injected into agent pod env |
| `warren-secrets/sentry-dsn` | warren | `SENTRY_DSN` | error reporting (optional) |
| `warren-secrets/warren-auth` | warren | `WARREN_AUTH` | auth posture: `token` (default) or `public` (optional) |
| `warren-secrets/warren-public-allowlist` | warren | `WARREN_PUBLIC_ALLOWLIST` | owners (`my-org`) and/or repos (`some-owner/some-repo`) a public instance may hold (required iff `warren-auth=public`) |
| `judge-secrets/judge-export-token` | warren | `WARREN_JUDGE_EXPORT_TOKEN` | bearer credential for the judge export proxy (`WARREN_JUDGE_BASE_URL` in `base/deployment.yaml`; optional — unset disables the surface) |
| `warren-git-token/token` | warren-runs | `WARREN_GIT_TOKEN` (init pod + agent pod) | init-container clone; salvage-window rescue push (harness-only, scrubbed from the agent child) |
| `warren-openrouter-key/api-key` | warren-runs | `OPENROUTER_API_KEY` (agent pod) | OpenRouter auth for `openrouter`-provider runs (optional) |

### Going public

The last two keys hold config, not credentials. They live in `warren-secrets`
so that an operator flips the posture — and reverts it — with a Secret edit
plus a rollout restart, rather than a redeploy. To enable public read-only
access:

```bash
kubectl -n warren patch secret warren-secrets --type merge -p \
  '{"stringData":{"warren-auth":"public","warren-public-allowlist":"<owner>|<owner>/<repo>[,...]"}}'
kubectl -n warren rollout restart deploy/warren
```

To revert, set `warren-auth` back to `token` (or `""`) and restart again.
Both keys fail safe. An absent or blank `warren-auth` resolves to `token`.
Public mode with an empty allowlist refuses to boot instead of serving
everything, and under a rolling update that leaves the previous pod in
service.

## RBAC (design Q4 / R5)

The control-plane ServiceAccount (`warren`, in namespace `warren`) gets a `Role` +
`RoleBinding` in `warren-runs` **only** — no ClusterRole, no cluster-wide grants.
Verbs are exactly what `src/runtime/k8s/` exercises:

- `pods`: `get, list, watch, create, delete` — dispatch, informer, reap, GC.
- `pods/log`: `get, watch` — the pod-log NDJSON event stream.
- `configmaps`: `get, list, create, delete` — seed-file ConfigMaps (create at
  dispatch, list/delete at GC).

No `update`/`patch` (warren replaces, never mutates in place); no `secrets` read
(agent secrets are injected as pod env by the control plane, not read from the API
by run pods). Verified on k3d with `kubectl auth can-i --as=system:serviceaccount:warren:warren`:
every listed verb `yes` in `warren-runs`, and `no` for the same verbs in other
namespaces, cluster-wide, and for unused verbs (`update`/`patch`/`secrets`/`nodes`).

## ResourceQuota + LimitRange

`warren-runs` carries a `ResourceQuota` (50 pods; 100 CPU / 200Gi requests, 200
CPU / 200Gi limits) as the hard backstop behind warren's soft admission caps
(`WARREN_K8S_MAX_QUEUE_DEPTH` / `_MAX_PENDING_PODS` / `_MAX_PROJECT_CONCURRENCY`).

A compute `ResourceQuota` rejects any pod whose containers don't **all** declare
requests + limits. Warren's agent container does, but the `workspace-init` init
container does **not** (`pod-spec.ts` builds no `resources` for it). The paired
`LimitRange` (`warren-runs-defaults`) supplies container defaults so the init
container inherits them and the pod admits — without it every dispatch would fail
with `must specify requests.cpu`. If you rename or drop the ResourceQuota, the
LimitRange can stay (harmless); if you keep the quota, keep the LimitRange.

## kind / k3d vs GKE

| | kind / k3d (local) | GKE Autopilot |
|---|---|---|
| Overlay | `overlays/kind` | `overlays/gke` |
| Images | `kind load` / `k3d image import`; `imagePullPolicy: Never` | Artifact Registry paths (edit `images:` + env in the overlay); pinned digests recommended |
| Ingress class | `nginx` (install ingress-nginx first) | `gce` — global static IP + `ManagedCertificate` TLS + `FrontendConfig` HTTPS redirect (all in the overlay) |
| Service type | ClusterIP | ClusterIP + NEG annotation (container-native LB; no NodePort) |
| StorageClass | `local-path` default (WaitForFirstConsumer) | `standard-rwo` default |
| repo-cache PVC | off (opt-in) | off (opt-in) |

**k3d ingress note:** k3d ships Traefik by default. The kind overlay sets
`ingressClassName: nginx`; on k3d either install ingress-nginx or start the
cluster with `--k3s-arg "--disable=traefik@server:0"` and deploy ingress-nginx,
or patch the class to `traefik`. Ingress backing is not required to validate the
manifests — the object applies regardless.

**Container images** (build + push separately; the manifests only reference tags):

- `warren:latest` — control-plane image (root `Dockerfile`; boots `warren serve`).
- `warren-agent:latest` (`WARREN_K8S_AGENT_IMAGE`) — the in-pod agent toolchain
  (`deploy/docker/Dockerfile.agent`). Bakes bun + Node + the coding-agent CLIs
  (claude-code, pi, sapling) + os-eco CLIs (canopy/seeds/mulch/plot) + warren
  source. Runs `bun run agent:run` (`src/runtime/k8s/agent-entrypoint.ts`): it
  resolves the selected runtime off burrow's registry, launches the agent binary
  directly (the pod is the sandbox — no bwrap), streams NDJSON events on stdout,
  drains the steering inbox, and execs the finalize step after the agent exits.
- `warren-workspace-init:latest` (`WARREN_K8S_INIT_IMAGE`) — lightweight bun+git
  init image (`deploy/docker/Dockerfile.workspace-init`) running
  `bun run workspace:init`.

Build all three (and optionally load them into a local cluster) with the helper:

```bash
# build all three images (tags default to :latest; TAG=… overrides)
deploy/docker/build-images.sh

# build + load into a running k3d / kind cluster (the local overlays pin
# imagePullPolicy: Never, so the node must already hold the image)
deploy/docker/build-images.sh --load-k3d  <cluster-name>
deploy/docker/build-images.sh --load-kind <cluster-name>

# build a single image
deploy/docker/build-images.sh --only agent    # control | agent | init
```

The equivalent raw commands (build from the repo root, then import):

```bash
docker build -f deploy/docker/Dockerfile.agent          -t warren-agent:latest .
docker build -f deploy/docker/Dockerfile.workspace-init -t warren-workspace-init:latest .
docker build -f Dockerfile                              -t warren:latest .

k3d image import warren-agent:latest warren-workspace-init:latest warren:latest --cluster <name>
# or, for kind:
kind load docker-image warren-agent:latest --name <name>   # repeat per image
```

For GKE, retag to your Artifact Registry path, `docker push`, and point the
`images:` block (or `WARREN_K8S_AGENT_IMAGE` / `WARREN_K8S_INIT_IMAGE`) at the
pushed refs.

**Agent secrets.** The agent container sources `ANTHROPIC_API_KEY` from an
OPTIONAL `secretKeyRef` (`WARREN_K8S_ANTHROPIC_SECRET_NAME` /
`_KEY`, default Secret `warren-anthropic-key` key `api-key`) so a run whose key
rides the dispatch env still schedules when the Secret is absent. Provision the
Secret alongside `warren-git-token` (design §6.3). `OPENROUTER_API_KEY` rides
the same pattern (`WARREN_K8S_OPENROUTER_SECRET_NAME` / `_KEY`, default Secret
`warren-openrouter-key` key `api-key`) for `openrouter`-provider runs.

## Host-mode local dev: kubeconfig 401 with client-cert clusters

Warren loads cluster auth via `@kubernetes/client-node`'s
`KubeConfig.loadFromDefault()` (`src/runtime/k8s/provider.ts`,
`log-follow.ts`). In a pod that resolves to the mounted ServiceAccount
(CA + bearer token); off-cluster it falls back to `KUBECONFIG` /
`~/.kube/config`.

**Symptom.** Running the control plane on your host with
`WARREN_RUNTIME=k8s` against a **k3d / kind** cluster — whose default
kubeconfig uses **client-certificate** auth against a **self-signed**
cluster CA — every Kubernetes API call fails with **HTTP 401**, so no run
pod ever dispatches.

**Cause.** Bun's `fetch` (the transport `@kubernetes/client-node` uses)
does not present the kubeconfig's client certificate and rejects the
self-signed cluster CA, so mTLS kubeconfig auth never completes. This is a
host-mode-only limitation: **in-cluster ServiceAccount bearer-token auth
is unaffected** — a warren pod deployed via these manifests authenticates
normally, which is the supported production path. Only off-cluster
`kubectl`-style client-cert kubeconfigs hit this.

**Workarounds** (local dev only — pick one):

*Option A — `kubectl proxy` (simplest; plain HTTP, no TLS/client-cert):*

```bash
# Terminal 1: proxy authenticates with your real kubeconfig,
# re-exposing the API over plain HTTP on localhost.
kubectl proxy --port=8001

# Terminal 2: throwaway kubeconfig that points warren at the proxy.
cat > /tmp/warren-proxy.kubeconfig <<'EOF'
apiVersion: v1
kind: Config
clusters:
  - name: proxy
    cluster: { server: http://127.0.0.1:8001 }
contexts:
  - name: proxy
    context: { cluster: proxy, user: "" }
current-context: proxy
EOF

KUBECONFIG=/tmp/warren-proxy.kubeconfig WARREN_RUNTIME=k8s warren serve
```

*Option B — token-based kubeconfig (bearer token + skip TLS verify):*

```bash
# ServiceAccount + short-lived token (TokenRequest API; kubectl >= 1.24).
kubectl -n warren create serviceaccount warren-host 2>/dev/null || true
kubectl create clusterrolebinding warren-host-admin \
  --clusterrole=cluster-admin \
  --serviceaccount=warren:warren-host 2>/dev/null || true
TOKEN=$(kubectl -n warren create token warren-host --duration=24h)
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')

# --insecure-skip-tls-verify dodges Bun's self-signed-CA rejection.
KC=/tmp/warren-token.kubeconfig
kubectl config set-cluster local --server="$SERVER" \
  --insecure-skip-tls-verify=true --kubeconfig="$KC"
kubectl config set-credentials warren-host --token="$TOKEN" --kubeconfig="$KC"
kubectl config set-context local --cluster=local --user=warren-host --kubeconfig="$KC"
kubectl config use-context local --kubeconfig="$KC"

KUBECONFIG="$KC" WARREN_RUNTIME=k8s warren serve
```

Both leave your real `~/.kube/config` untouched. `cluster-admin` is
convenient for local dev; to mirror production least-privilege, bind the
`base/rbac.yaml` Role in `warren-runs` to `warren-host` instead.

## Prometheus

`servicemonitor.yaml` is kept **out** of the kustomize base because it needs the
Prometheus Operator CRD (`monitoring.coreos.com/v1`), which a bare kind/k3d
cluster lacks (`kubectl apply` would fail). Apply it separately on clusters that
run the operator:

```bash
kubectl apply -f deploy/k8s/servicemonitor.yaml
```

## Repo cache (opt-in)

The git-mirror cache (warren-e908) is **off by default** as of warren-554f.
The base ships no `warren-repo-cache` PVC, and `deployment.yaml` does not set
`WARREN_K8S_REPO_CACHE_PVC`. Every run clones fresh.

warren-554f flipped the default because the cache is a `ReadWriteOnce` claim
shared by all run pods. Two concurrent run pods on different nodes deadlock on
it (Multi-Attach), and the second run stalls in Init. Direct clones cost
seconds against 5–20min runs. RWX storage (like GKE Filestore, 1TiB minimum)
costs too much to share a disk of small mirrors.

**Single-node clusters may opt back in** via an overlay that adds the claim and
re-sets the env:

```yaml
# overlays/<yours>/kustomization.yaml (excerpt)
patches:
  - target:
      kind: Deployment
      name: warren
    patch: |
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value: {name: WARREN_K8S_REPO_CACHE_PVC, value: warren-repo-cache}
  - patch: |
      apiVersion: v1
      kind: PersistentVolumeClaim
      metadata: {name: warren-repo-cache, namespace: warren-runs}
      spec:
        accessModes: ["ReadWriteOnce"]
        resources: {requests: {storage: 50Gi}}
```

When enabled, the init container mounts the claim at `/repo-cache` (override
with `WARREN_K8S_REPO_CACHE_PATH`) and keeps a per-repo bare mirror under it. A
run is then a `git fetch` + fast local clone instead of a full network clone
(design §4.3, R2). The run workspace itself still lives on the per-pod
`emptyDir` — the PVC is a *shared clone cache*, never the working tree.

Any cache failure falls back to a direct clone automatically, so a wedged
mirror never blocks a run. On local-path the PVC stays `Pending`
(WaitForFirstConsumer) until the first run pod mounts it — expected, not an
error.

**RWO caveat — switch to RWX BEFORE a second node.** The claim is
`ReadWriteOnce`, so only pods on the PVC's node can mount it. This is the
deadlock that made the cache opt-in. It is only safe while every run pod
schedules on one node.

Before scaling out, migrate the claim to a `ReadWriteMany` class (GKE Filestore
CSI; Longhorn on bare metal) and pin it via an overlay `storageClassName`
(design R2) — or simply leave the cache off.

**Multi-node clusters enable the cache with an RWX claim** (warren-8175).
The cache is worth the cost only when a repo is large. Each openclaw run pod
(~2.9GB) spent ~20min in Init on a fresh clone.

On GKE the cheapest RWX class is `standard-rwx` (Filestore Basic HDD). The
tier minimum is 1TiB, about $160–200/mo. The operator makes the cost call.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: warren-repo-cache
  namespace: warren-runs
spec:
  accessModes: ["ReadWriteMany"]
  storageClassName: standard-rwx
  resources: {requests: {storage: 1Ti}}
```

Create the claim with `kubectl apply -f`, like the Secrets. The deploy
workflow never creates storage.

Then set the repo variable `WARREN_K8S_REPO_CACHE_PVC=warren-repo-cache`.
The render step in `deploy-gke.yml` wires the env onto the Deployment on
each deploy, so the setting survives releases.

The class binds on first consumer, and a Filestore instance takes about
15–25min to provision. The first pod that mounts the claim waits for that
provisioning.

A one-off pre-warm Job that mounts the claim moves the wait off the first
real run. The same Job can also seed the mirror of a large repo.

## Known follow-ups

- **`/readyz` probes.** Deployment probes use the auth-exempt `/healthz`. Deeper
  readiness (`/readyz`, which mirrors DB/canopy checks) requires the bearer token;
  wire it via a probe `httpHeaders: [{name: Authorization, value: "Bearer …"}]`
  if you want readiness gated on those checks.
```
