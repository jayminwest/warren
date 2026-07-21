# GKE Autopilot deploy prep (warren-4e36)

Working prep document for plan `pl-829f` step 27 (provision GKE, migrate
secrets, deploy, smoke-test). Assembled 2026-07-13 while warren-245d
(kind/k3d validation) and warren-74b5 (manifests + RBAC) were in flight.
This is scratch material for the deploy session — the durable operator
doc is warren-5b6d's K8s RUNBOOK, which should absorb whatever survives
contact with the real cluster.

Facts below were extracted from `docs/design/k8s-migration-plan.md`
(authoritative; supersedes `k8s-migration.md` where they disagree),
`src/runtime/k8s/`, `Dockerfile`, `fly.toml`, and `.env.example` on the
`k8s-migration` branch.

---

## 0. Operator-machine prerequisites (do these first — interactive)

| Item | Status 2026-07-13 | Action |
|---|---|---|
| `gcloud` | **not installed** | `brew install --cask gcloud-cli` (or nixpkgs `google-cloud-sdk` — kubectl/helm/fly are Nix-managed on this machine) |
| `gke-gcloud-auth-plugin` | not installed | `gcloud components install gke-gcloud-auth-plugin` (brew cask bundles gcloud only) |
| gcloud auth | — | `gcloud auth login && gcloud config set project <PROJECT_ID>` |
| Docker daemon | running (28.4.0) | — |
| kubectl | v1.36.2 | — |
| k3d | v5.8.3 | covers warren-245d locally |
| `fly` CLI | logged out | **not needed** — the full deployed secret set (incl. Supabase `WARREN_DB_URL`) lives locally in the gitignored `.env.deployed`, which was the source for `fly secrets import` |

**Apple Silicon gotcha:** Autopilot schedules amd64 by default. Build all
images with `--platform linux/amd64` (or push multi-arch); a bare
`docker build` on this machine produces arm64 images that CrashLoop on
GKE with `exec format error`.

## 1. Parameters (fill in before running anything)

Decided 2026-07-13 (operator): region **us-west1**, database
**Supabase Postgres**, exposure **port-forward first** (Ingress + TLS
deferred until after the smoke test).

**Provisioned 2026-07-13** — §0, §2, and §4's namespace/secret steps are
DONE; do not re-run:
- Project `warren-502318`, authed as jayminwest@gmail.com.
- APIs enabled; Artifact Registry repo
  `us-west1-docker.pkg.dev/warren-502318/warren` created; local docker
  push auth configured.
- Autopilot cluster `warren` RUNNING in us-west1 (GKE 1.35.5); kubectl
  context `gke_warren-502318_us-west1_warren`.
- Namespaces `warren` + `warren-runs` created.
- Secrets created from `.env.deployed`: `warren/warren-secrets`
  (WARREN_API_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN, WARREN_DB_URL,
  GEMINI_API_KEY, CANOPY_REPO_URL) and `warren-runs/warren-git-token`
  (key `token`). SENTRY_DSN was unpopulated — add later if wanted.

Remaining for the deploy session: build/push the three images (§3),
apply warren-74b5's manifests, port-forward, smoke test (§7).

```bash
export PROJECT_ID=...                # GCP project — only open parameter
export REGION=us-west1               # decided: Oregon
export CLUSTER=warren
export AR_REPO=warren                # Artifact Registry docker repo
export AR=${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}
```

## 2. One-time GCP provisioning

```bash
gcloud services enable container.googleapis.com artifactregistry.googleapis.com
# + sqladmin.googleapis.com if using Cloud SQL (see §5)

gcloud artifacts repositories create ${AR_REPO} \
  --repository-format=docker --location=${REGION}
gcloud auth configure-docker ${REGION}-docker.pkg.dev

gcloud container clusters create-auto ${CLUSTER} \
  --region=${REGION} --release-channel=regular

gcloud container clusters get-credentials ${CLUSTER} --region=${REGION}
```

Autopilot notes:
- No node pools to manage; billing is per-pod requests.
- **Autopilot raises requests to equal limits.** The pod-spec builder
  emits requests cpu 1 / mem 2Gi vs limits cpu 4 / mem 4Gi
  (`src/runtime/k8s/pod-spec.ts`); Autopilot will admit the pod at
  4 cpu / 4Gi *requests*, which is what you pay for. Verify admitted
  specs on the first run (`kubectl get pod -o yaml | grep -A6 resources`)
  and consider setting per-project `resources` so request==limit
  intentionally.
- Restricted PodSecurity is enforced; the builder's securityContext
  (non-root 1000, drop ALL, seccomp RuntimeDefault, no privilege
  escalation, `restartPolicy: Never`) already complies.

## 3. Images (three of them)

| Image | Env var | Source | Status |
|---|---|---|---|
| Control plane | referenced by the Deployment | root `Dockerfile` | exists, but ENTRYPOINT is the supervisor (spawns `burrow serve`) — **override the Deployment command to `["bun","run","src/server/main/index.ts"]`** to boot warren directly; no burrow child, no bwrap flags needed under `WARREN_RUNTIME=k8s` |
| Agent (run pod) | `WARREN_K8S_AGENT_IMAGE` (default `warren-agent:latest`) | **no Dockerfile in repo yet** | expected out of warren-245d (kind validation needs it); toolchain per design doc: bun, node, git, claude-code, sapling, canopy/seeds/mulch/plot — the tail of the existing Dockerfile is the template |
| Workspace init | `WARREN_K8S_INIT_IMAGE` (default `warren-workspace-init:latest`) | **no Dockerfile in repo yet** | runs `bun run workspace:init` (`src/runtime/k8s/workspace-init.ts`); needs warren source + bun + git only |

Build/push (once Dockerfiles exist):

```bash
docker buildx build --platform linux/amd64 -t ${AR}/warren:$(git rev-parse --short HEAD) --push .
docker buildx build --platform linux/amd64 -t ${AR}/warren-agent:... --push -f Dockerfile.agent .
docker buildx build --platform linux/amd64 -t ${AR}/warren-workspace-init:... --push -f Dockerfile.workspace-init .
```

Defaults are bare `:latest` names with no registry — the Deployment MUST
set `WARREN_K8S_AGENT_IMAGE` / `WARREN_K8S_INIT_IMAGE` to fully-qualified
`${AR}/...` paths or GKE has nothing to pull.

## 4. Namespaces, secrets, config

Two namespaces (matches provider defaults):
- `warren` — control plane (Deployment/Service/Ingress/PVC).
- `warren-runs` — run pods (`WARREN_K8S_NAMESPACE`); ResourceQuota,
  Role/RoleBinding for the control-plane SA (pods + pods/log +
  configmaps: create/get/list/watch/delete — no cluster-scoped perms).

Secrets — source them from `.env.deployed` (the Fly deploy's secret
store; single-quote-safe sourcing per mx-b1e338). Do NOT
`--from-env-file` the whole file: it contains the burrow token pair,
which is LocalProvider-only dead weight in the cluster. Cherry-pick:

```bash
kubectl create ns warren warren-runs 2>/dev/null || true

set -a; source .env.deployed; set +a   # values single-quoted in-file
kubectl -n warren create secret generic warren-secrets \
  --from-literal=WARREN_API_TOKEN=$WARREN_API_TOKEN \
  --from-literal=ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  --from-literal=GITHUB_TOKEN=$GITHUB_TOKEN \
  --from-literal=WARREN_DB_URL=$WARREN_DB_URL        # Supabase (§5)
  # optional: SENTRY_DSN, WARREN_GIT_TOKEN, OPENAI_API_KEY, ...

# Init container reads this from the RUN namespace, not the control
# plane's (WARREN_K8S_GIT_SECRET_NAME/KEY, default warren-git-token/token).
# It's marked optional: public-repo clones work without it, but
# private-repo clone/push FAILS SILENTLY if you forget it.
kubectl -n warren-runs create secret generic warren-git-token \
  --from-literal=token=$GITHUB_TOKEN
```

Fly → K8s env mapping for the control-plane Deployment:

| Keep (from fly.toml) | Value |
|---|---|
| `WARREN_BIND_HOST` / `WARREN_BIND_PORT` | `0.0.0.0` / `8080` (containerPort + Service port `http` — the ServiceMonitor in `deploy/k8s/servicemonitor.yaml` assumes the port is *named* `http` and label `app.kubernetes.io/name: warren`) |
| `WARREN_DATA_DIR` | `/data` (PVC, 5Gi RWO — holds canopy + project clones; warren.db unused once on Postgres) |
| `WARREN_MERGE_POLLER_ENABLED` | `1` |
| `WARREN_RUN_HEARTBEAT_TIMEOUT_MS` | `2700000` (K8s OOM fast-fail makes this a backstop, not the primary detector) |

| Add (new for K8s) | Value |
|---|---|
| `WARREN_RUNTIME` | `k8s` |
| `WARREN_K8S_AGENT_IMAGE` / `WARREN_K8S_INIT_IMAGE` | `${AR}/warren-agent:...` / `${AR}/warren-workspace-init:...` |
| `WARREN_K8S_NAMESPACE` | `warren-runs` (default, set explicitly) |
| `WARREN_K8S_CALLBACK_SERVICE`/`_NAMESPACE`/`_PORT` | `warren` / `warren` / `8080` (defaults; = Service DNS `warren.warren.svc.cluster.local:8080`) |
| admission knobs | `WARREN_K8S_MAX_QUEUE_DEPTH` (50), `WARREN_K8S_MAX_PENDING_PODS` (20), `WARREN_K8S_MAX_PROJECT_CONCURRENCY` (unset = unlimited) — defaults fine to start |

| Drop (burrow/LocalProvider-only) | |
|---|---|
| `BURROW_API_TOKEN`, `WARREN_BURROW_TOKEN`, `BURROW_DATA_DIR`, all bwrap security overrides | not read under `WARREN_RUNTIME=k8s` |

Never set by hand (provider-injected into pods): `WARREN_API_URL`,
`WARREN_RUN_ID`, `WARREN_REPO_URL`, `WARREN_BRANCH`, `WARREN_BASE_BRANCH`,
`WARREN_WORKSPACE_PATH`, `WARREN_SEED_MANIFEST`.

## 5. Database — Postgres required in practice

Nothing in code *forces* Postgres under `WARREN_RUNTIME=k8s` (`run_inbox`
has both sqlite `0029` and postgres `0023` migrations), but SQLite on a
RWO PVC is a single-replica trap and the design doc mandates Postgres for
this topology. Deliberately set `WARREN_DB_URL=postgres://...`.

**Decided: Supabase — and it already exists.** The 2026-05-14 Fly
dogfood deploy ran against a Supabase Postgres; the populated
`WARREN_DB_URL` (session pooler) lives in the gitignored
`.env.deployed` at the repo root, alongside the rest of the deployed
secret set (that file was the source for `fly secrets import`, so
nothing needs recovering from Fly). Known gotchas from mulch
(mx-b1e338 / mx-a629b6):

- The URL must carry `sslmode=require&uselibpqcompat=true` — without
  the compat flag, pg-connection-string treats `sslmode=require` as
  verify-full and rejects Supabase's pooler cert chain with
  `SELF_SIGNED_CERT_IN_CHAIN`.
- Single-quote the value when sourcing the file in a shell — the `&`
  in the query string forks otherwise.

**In-place migration caveat:** this DB carries live schema + dogfood
data from May–July. On first boot the k8s-migration branch will apply
postgres migrations up through `run_inbox` (0023) **and the
workers/burrows table drop** (step 24, warren-3743) against it. That is
the intended big-bang path (no live users).
**Snapshot taken 2026-07-13**: full `pg_dump -Fc` at
`~/warren-backups/warren-supabase-2026-07-13.dump` (1.7 GB; source DB
11 GB, ~all `events`). TOC verified with `pg_restore --list` — all 12
public tables present incl. the doomed `workers`/`burrows`.

**Host/IPv6 gotcha (discovered taking the snapshot):** the direct
`db.<ref>.supabase.co` host in `.env.deployed`'s `WARREN_DB_URL` is
**IPv6-only**. It worked from Fly (IPv6 egress) but does not resolve
to IPv4. GKE Autopilot pods are IPv4-only by default, so **the deployed
`WARREN_DB_URL` will likely need rewriting to the session pooler**:
host `aws-1-us-west-1.pooler.supabase.com:5432`, username
`postgres.<ref>` (tenant form), same password/database. Verify from a
debug pod before first boot; the `warren-secrets` Secret currently
holds the direct-host URL. Note it's `aws-1-…` — the older `aws-0-…`
pooler generation returns "tenant not found" for this project.

Cloud SQL remains the fallback if Supabase latency from us-west1
disappoints (it adds VPC peering or an auth-proxy sidecar).

Existing Postgres migrations apply as-is on first boot; no data
migration (main is frozen, Fly machine decommissioned, no live users).

## 6. Ingress / exposure

**Decided: port-forward first** — smoke test with no Ingress:
`kubectl -n warren port-forward svc/warren 8080:8080`. GKE Ingress +
`ManagedCertificate` + static IP (+ `BackendConfig` pointing health
checks at `/healthz`) comes after the smoke test passes and a domain is
chosen; consider IAP if the UI should not be public. UI auth today is
just `WARREN_API_TOKEN` on the login screen.

## 7. Smoke-test script (acceptance for warren-4e36)

1. `kubectl -n warren get pods` — control plane Ready; `curl :8080/healthz` via port-forward.
2. Register/refresh a project; dispatch a run (`warren run claude-code <project> -p "..."`).
3. `kubectl -n warren-runs get pods -l warren.io/run-id=<id>` — init container clones, agent starts.
4. Events stream in the UI (pod-log bridge, synthesized seq); refresh mid-run to prove resume.
5. Steer the run; message reaches the agent within ~5s (inbox poll).
6. Finalize: in-pod reap posts mirror deltas; branch pushed; PR opens.
7. OOM drill: dispatch a memory-hog prompt with a low per-run limit → run fails in seconds with `terminalReason: oom_killed` (not the 45-min watchdog).
8. Cancel drill: cancel a running pod; grace 30s; pod GC removes terminal pods >30min.
9. Admission drill (optional): flood dispatches past `WARREN_K8S_MAX_QUEUE_DEPTH` → HTTP 429 + `Retry-After`.

## 8. Known gaps / coordinate with the other two work streams

- **warren-74b5 must deliver**: namespace pair, SA + Role/RoleBinding
  (verbs above, incl. `configmaps` and `watch` — the informer and seed
  ConfigMaps need more than the plan text's "pods + pods/log"),
  ResourceQuota (design suggests 50 pods / 100 cpu / 200Gi), Deployment
  (with the direct-boot command override), Service (named port `http`),
  Ingress, Secret templates, PVC. Only `deploy/k8s/servicemonitor.yaml`
  exists today.
- **warren-245d must deliver (or 4e36 inherits)**: agent + init image
  Dockerfiles — no build exists for either.
- **Preview environments are disabled on K8s** (`previewPorts: false`, deferred).
- **Cold clones every run**: the repo-cache PVC / warm-clone optimization
  in the design doc is not implemented; init clones fresh. Fine for
  smoke; cost/latency item later.
- **Fallback host** if GKE IAM/VPC friction blocks progress:
  DigitalOcean/Linode managed K8s (plan risk #5) — the provider only
  needs a kubeconfig.
