# Warren Kubernetes manifests

Manifests + RBAC for running the warren control plane on Kubernetes with
pod-per-run agent sandboxes (design [`docs/design/k8s-migration.md`](../../docs/design/k8s-migration.md)
§6.2/§6.3/R5/Q4 and [`k8s-migration-plan.md`](../../docs/design/k8s-migration-plan.md)
§3.2). Hosted target is **GKE Autopilot**; everything applies on **kind**/**k3d**
for local validation.

## Layout

```
deploy/k8s/
  base/                 controller-/cloud-agnostic manifests (kustomize base)
    namespaces.yaml       warren (control plane) + warren-runs (run pods)
    serviceaccount.yaml   control-plane ServiceAccount
    rbac.yaml             Role + RoleBinding scoped to warren-runs ONLY
    resourcequota.yaml    ResourceQuota (50 pods) + LimitRange defaults
    secrets.yaml          Secret TEMPLATES (placeholders — do not apply as-is)
    pvc.yaml              warren-data (5Gi) + warren-repo-cache (50Gi)
    deployment.yaml       warren control-plane Deployment
    service.yaml          ClusterIP Service (callback DNS + ingress backend)
    ingress.yaml          controller-agnostic Ingress
    kustomization.yaml
  overlays/
    kind/                 local: nginx ingress, imagePullPolicy Never, small PVC
    gke/                  GKE Autopilot: Artifact Registry images, gce Ingress, NodePort
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
# Same value as github-token. Optional — public repos clone without it.
kubectl -n warren-runs create secret generic warren-git-token \
  --from-literal=token=<gh PAT>
```

| Secret / key | Namespace | warren env var | Purpose |
|---|---|---|---|
| `warren-secrets/warren-api-token` | warren | `WARREN_API_TOKEN` | API bearer auth |
| `warren-secrets/warren-db-url` | warren | `WARREN_DB_URL` | Postgres DSN (optional → SQLite) |
| `warren-secrets/github-token` | warren | `GITHUB_TOKEN` | git push / private clone |
| `warren-secrets/anthropic-api-key` | warren | `ANTHROPIC_API_KEY` | injected into agent pod env |
| `warren-secrets/sentry-dsn` | warren | `SENTRY_DSN` | error reporting (optional) |
| `warren-git-token/token` | warren-runs | `WARREN_GIT_TOKEN` (init pod) | init-container clone |

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
| Ingress class | `nginx` (install ingress-nginx first) | `gce` (+ attach a `ManagedCertificate` for TLS) |
| Service type | ClusterIP | NodePort (GCE Ingress needs it; or ClusterIP + NEG annotation) |
| StorageClass | `local-path` default (WaitForFirstConsumer) | `standard-rwo` default |
| repo-cache PVC | 5Gi (overlay-shrunk) | 50Gi |

**k3d ingress note:** k3d ships Traefik by default. The kind overlay sets
`ingressClassName: nginx`; on k3d either install ingress-nginx or start the
cluster with `--k3s-arg "--disable=traefik@server:0"` and deploy ingress-nginx,
or patch the class to `traefik`. Ingress backing is not required to validate the
manifests — the object applies regardless.

**Container images** (build + push separately; the manifests only reference tags):

- `warren:latest` — control-plane image (boots `warren serve`).
- `warren-agent:latest` (`WARREN_K8S_AGENT_IMAGE`) — baked agent toolchain.
- `warren-workspace-init:latest` (`WARREN_K8S_INIT_IMAGE`) — bun+git init image
  running `bun run workspace:init`.

## Prometheus

`servicemonitor.yaml` is kept **out** of the kustomize base because it needs the
Prometheus Operator CRD (`monitoring.coreos.com/v1`), which a bare kind/k3d
cluster lacks (`kubectl apply` would fail). Apply it separately on clusters that
run the operator:

```bash
kubectl apply -f deploy/k8s/servicemonitor.yaml
```

## Known follow-ups

- **`warren-repo-cache` is forward-provisioned.** The current pod spec
  materializes the workspace onto an `emptyDir`; wiring the init container to
  fetch into this PVC (the `discoverHostClone` cache, design §4.3) is a follow-up.
  On local-path it stays `Pending` (WaitForFirstConsumer) until something mounts
  it — expected, not an error.
- **RWO on multi-node.** `warren-repo-cache` is `ReadWriteOnce`; a second worker
  node needs an RWM class (Filestore on GKE, Longhorn on bare metal) before init
  containers can schedule off the PVC's node (design R2).
- **`/readyz` probes.** Deployment probes use the auth-exempt `/healthz`. Deeper
  readiness (`/readyz`, which mirrors DB/canopy checks) requires the bearer token;
  wire it via a probe `httpHeaders: [{name: Authorization, value: "Bearer …"}]`
  if you want readiness gated on those checks.
```
