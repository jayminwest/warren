# Warren on Kubernetes — Operations Runbook

Operator playbook for warren's **K8sProvider** topology: the control plane runs as a `Deployment`, and each agent run gets its own pod.
This runbook is the durable operations document.
It covers deploy, secrets, RBAC, garbage collection, admission control, observability, and incident response.

**Scope.** This runbook covers the `WARREN_RUNTIME=k8s` topology only.
For the default self-host topology, which runs warren's `LocalProvider` in one container, see the [Docker self-host guide](self-host/docker.md) and the [Operators section](../README.md#operators) of the root README.
That path needs none of this document.

**Cross-references** (read these documents, do not duplicate them here):

- [`deploy/k8s/README.md`](../deploy/k8s/README.md) — the manifest **quick start**: `kubectl apply -k`, overlay layout, secret-creation commands, and the host-mode kubeconfig-401 workaround. This runbook links into it and does not restate it.
- [`docs/design/k8s-migration.md`](design/k8s-migration.md) and [`runtime-provider-contract.md`](design/runtime-provider-contract.md) — the architecture decisions behind everything in this runbook. Both are historical records of work that shipped in v0.10.0.

---

## 0. The runtime-provider model

Warren selects its run backend once at boot from `WARREN_RUNTIME` (`src/runtime/registry.ts`).
Unset or `local` selects the warren-owned `LocalProvider`, the self-host default.
The values `docker` and `k8s` select the sibling-container and pod providers.
All providers implement the same `RuntimeProvider` contract (`src/runtime/contract.ts`), so the domain (`src/runs/*`) is identical across topologies.
Only workspace materialization, event streaming, steering transport, and finalization differ.

Under `k8s`, there is no `bwrap` sandbox or local supervisor child for the run.
Each run is a bare pod (`restartPolicy: Never`) in the `warren-runs` namespace, and the pod boundary is the sandbox.
A bad `WARREN_RUNTIME` value fails loud at boot (`UnknownRuntimeError`) and never falls back silently.

The four `bwrap` security flags belong only to the local container topology and must stay absent from the Kubernetes deployment.
Retired burrow token, socket, and data-directory variables also stay unset.

---

## 1. Deploy

### 1.1 Hosted target — GKE Autopilot

Autopilot is the reference hosted target (deployed live 2026-07-13, warren-4e36).
Autopilot manages nodes, bills per-pod requests, and enforces restricted PodSecurity.
The pod-spec builder (`src/runtime/k8s/pod-spec.ts`) already complies: non-root uid 1000, `drop: [ALL]`, `seccompProfile: RuntimeDefault`, no privilege escalation, `restartPolicy: Never`.

One-time provisioning:

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

- **Autopilot raises requests to equal limits.** The builder emits requests cpu 1 / mem 2Gi and limits cpu 4 / mem 4Gi. Autopilot admits the pod at 4 cpu / 4Gi *requests* — that is what you pay for. Check the admitted spec on the first run: `kubectl -n warren-runs get pod <run> -o yaml | grep -A6 resources`. If the cost matters, set per-project `resources` so that request equals limit on purpose (`.warren/config.yaml`, `src/warren-config/resources-config.ts`).
- **Apple Silicon → amd64.** Autopilot schedules amd64. Build all three images with `docker buildx build --platform linux/amd64`, or they CrashLoop with `exec format error`.

### 1.2 Three images

The manifests reference tags only — you build and push the images separately.
The helper script is `deploy/docker/build-images.sh`.
See [`deploy/k8s/README.md`](../deploy/k8s/README.md) for `--load-k3d`, `--load-kind`, and `--only`.

| Image | Env var | Dockerfile | Role |
|---|---|---|---|
| `warren` (control plane) | referenced by the Deployment | root `Dockerfile` | boots `warren serve` directly (Deployment overrides ENTRYPOINT away from the supervisor — no burrow child under k8s) |
| `warren-agent` | `WARREN_K8S_AGENT_IMAGE` (default `warren-agent:latest`) | `deploy/docker/Dockerfile.agent` | the run pod's toolchain: bun, node, git, python3 + uv (warren-fabb), the coding-agent CLIs + os-eco CLIs; runs `bun run agent:run` (`src/runtime/k8s/agent-entrypoint.ts`) |
| `warren-workspace-init` | `WARREN_K8S_INIT_IMAGE` (default `warren-workspace-init:latest`) | `deploy/docker/Dockerfile.workspace-init` | lightweight bun+git init container; runs `bun run workspace:init` (`src/runtime/k8s/workspace-init.ts`) |

The `:latest` defaults name no registry.
The Deployment **must** set `WARREN_K8S_AGENT_IMAGE` / `WARREN_K8S_INIT_IMAGE` to fully-qualified registry paths, or the cluster has nothing to pull.
Pin the images by digest on GKE.

### 1.3 Apply the manifests

Everything is kustomize — pick an overlay.
Full detail (secret creation, overlay differences, ingress notes) lives in [`deploy/k8s/README.md`](../deploy/k8s/README.md).
Do not re-derive that detail here.

```bash
kubectl apply -k deploy/k8s/overlays/gke     # GKE Autopilot
kubectl apply -k deploy/k8s/overlays/kind    # local kind / k3d dev
```

Both overlays **delete the placeholder Secret templates** from the render —
the apply will not create them. Create the real Secrets imperatively
BEFORE applying (commands in [`deploy/k8s/README.md`](../deploy/k8s/README.md),
"Secrets — never commit real values"), because without `warren-secrets`
the pod blocks in CreateContainerConfigError (warren-df5c).

The base creates:

- Two namespaces: `warren` for the control plane, `warren-runs` for run pods.
- A ServiceAccount plus the RBAC Role and RoleBinding (§4).
- A ResourceQuota with its paired LimitRange.
- Run-pod NetworkPolicies (default-deny ingress + coarse egress — §4.1).
- One PVC: `warren-data` (5Gi). The `warren-repo-cache` claim is opt-in via overlay (§5.3, warren-554f).
- The Deployment, the Service, and the Ingress.

Apply `servicemonitor.yaml` separately — it needs the Prometheus Operator CRD.

### 1.4 Local dev (kind / k3d)

The `overlays/kind` overlay pins `imagePullPolicy: Never` (load images into the node first), nginx ingress, and a shrunk repo-cache PVC.

One caveat will waste an afternoon.
A control plane **on your host** against a k3d/kind cluster gets an **HTTP 401 on every K8s API call**.
Bun's `fetch` cannot present the kubeconfig client cert against the self-signed cluster CA.
In-cluster ServiceAccount bearer-token auth (the production path) does not have this problem.
Two workarounds (`kubectl proxy`, or a token kubeconfig with `--insecure-skip-tls-verify`) are in [`deploy/k8s/README.md`](../deploy/k8s/README.md) under "Host-mode local dev".

### 1.5 Database — Postgres in practice

Nothing in code *forces* Postgres under `k8s` — `run_inbox` has both a sqlite and a postgres migration.
But SQLite on a `ReadWriteOnce` PVC is a single-replica trap.
Set `WARREN_DB_URL=postgres://...` deliberately.
Agent run pods never get the DB URL — only the control plane does (§3, blast-radius minimization).
Run pods talk to warren over HTTP and never to the DB, so a database cutover does not touch them.

**In-cluster Postgres (Component, warren-9f5a; the production database since 2026-09-03).**
The kustomize Component `deploy/k8s/components/postgres/` runs Postgres inside the cluster: a
StatefulSet on the postgres 17 image (one replica, 250m/1Gi requests, 1/2Gi limits, 10Gi PVC with
`pg_isready` readiness), a ClusterIP Service on 5432, and a placeholder Secret template
(`postgres-credentials`, never apply it as-is).

A NetworkPolicy admits ingress only from the warren control-plane pods in namespace `warren`.
Run pods in `warren-runs` stay denied.
The PVC omits `storageClassName`, so the GKE default `standard-rwo` binds.

The image runs postgres 17. Keep the major pinned when restoring an old dump so
`pg_restore` stays same-major. The backup CronJob layer under
`deploy/k8s/components/postgres/backup/` (warren-6db7) is the restore path.

**Historical: Supabase (until September 3, 2026, warren-a3ed).** Supabase Postgres was the
production database until the cutover of September 3, 2026 (warren-c01d) moved it to the
in-cluster component above. Its pooler-host, sslmode, uselibpqcompat, and
shell-quoting gotchas died with the migration. See the cutover checklist (§1.5). The operator deleted the Supabase project on
September 3, 2026 (warren-f7e6), the same day as the cutover, after the live server served
post-cutover runs from the in-cluster database. Two archives of it live in the backup bucket:
`gs://warren-pg-backups-502318/warren/supabase-cutover-2026-09-03.dump` (the final Supabase
state at cutover, 96 MB) and `gs://warren-pg-backups-502318/warren/supabase-archive-2026-07-13.dump`
(the July full-history snapshot described below, 1.7 GB).

**Pre-migration snapshot (rollback anchor).** Before the Fly→GKE cutover, the operator took a full `pg_dump -Fc` snapshot of the production DB on 2026-07-13: `~/warren-backups/warren-supabase-2026-07-13.dump` on the operator workstation (1.7 GB, from an 11 GB source DB that is almost all `events`). A `pg_restore --list` check confirmed the TOC holds all 12 then-public tables, including the since-dropped `workers`/`burrows`. This snapshot is the restore point for anything that predates the cutover. A copy is in the backup bucket as `warren/supabase-archive-2026-07-13.dump`.

#### Backups (warren-6db7)

An in-cluster database is only acceptable with independent restore paths.
Three layers exist, deliberately independent of each other:

| Layer | Mechanism | Retention |
| --- | --- | --- |
| Logical dumps | Nightly `pg_dump -Fc -n public -n drizzle --no-owner --no-privileges` CronJob (`postgres-backup`, 03:00 UTC) uploads to `gs://warren-pg-backups-502318/warren/<date>.dump` via Workload Identity (SA `postgres-backup` → GSA `postgres-backup@warren-502318.iam.gserviceaccount.com`) | 30 days (bucket lifecycle rule) |
| Disk snapshots | GCP snapshot schedule `warren-pg-daily` attached to the PVC's PersistentDisk | 14 daily snapshots |
| Volume itself | PVC `reclaimPolicy: Retain` — a deleted StatefulSet never deletes the disk | until an operator deletes it |

The dump CronJob runs as two containers sharing an emptyDir:

- `postgres:17` runs `pg_dump` (needs the same-major client. image major 17 matches the server).
- `google/cloud-sdk:slim` uploads the file with `gcloud storage cp` (has the storage CLI but no postgres client).

`concurrencyPolicy` is `Forbid`, the Job keeps 3 histories, and `backoffLimit` is 0. A failed backup shows `Failed` and never masks a broken dump. The bucket name is a ConfigMap key (`postgres-backup-config/backup-bucket-url`) so another operator can substitute their own bucket without editing the CronJob. The manifest directory is `deploy/k8s/components/postgres/backup/`.

Verify a nightly dump ran:

```bash
gcloud storage ls "gs://warren-pg-backups-502318/warren/" | tail -5
kubectl -n warren get cronjob postgres-backup -o wide
```

**Restore from a GCS dump (cold start).** Run this against an idle warren only. `--clean` drops all objects in the target database first, so drain the control plane (§7.6) before you restore. Scale warren to 0 first and keep it there until the smoke check passes. Do not edit a standing restore Job: a Job pod template is immutable, so the API server rejects `kubectl set env job/postgres-restore ...`. Render the template into a uniquely named throwaway Job instead.

```bash
# 1. Scale warren down so nothing writes to the DB.
kubectl -n warren scale deploy/warren --replicas=0

# 2. Render the template with the dump name (without the .dump suffix)
#    and a unique job name, then create it.
sed -e 's/__RESTORE_NAME__/postgres-restore-20260903/' \
    -e 's/__RESTORE_DUMP__/20260903/' \
    deploy/k8s/components/postgres/backup/restore-job.template.yaml \
  | kubectl -n warren create -f -
kubectl -n warren logs job/postgres-restore-20260903 -c restore -f
kubectl -n warren delete job postgres-restore-20260903

# 3. Smoke-check, then bring warren back.
kubectl -n warren run psql-check --rm -it --restart=Never \
  --image=postgres:17 --env "PGPASSWORD=$(kubectl -n warren get secret postgres-credentials -o jsonpath='{.data.postgres-password}' | base64 -d)" \
  -- psql -h postgres.warren.svc -U warren -d warren -c "select count(*) from runs;"
kubectl -n warren scale deploy/warren --replicas=1
```

If the rendered job name already exists from a previous attempt, delete it
first: `kubectl -n warren delete job postgres-restore-20260903`.

**Restore from a PD snapshot (cold start).** The snapshot is the disk, so it
restores the whole volume, not just warren-owned schemas. Use it when you lost
the disk, not for point-in-time schema repair:

```bash
gcloud compute snapshots list --filter="name~warren-pg-daily"
gcloud compute disks create warren-pg-restored-<date> \
  --source-snapshot=<SNAPSHOT_NAME> --zone=<ZONE> --type=pd-balanced
# stop postgres, swap the disk onto the postgres PVC (delete the PVC first;
# reclaimPolicy Retain keeps the old disk as the rollback), then restart.
```

The old disk survives deletion thanks to `reclaimPolicy: Retain`. Keep it
until you verify the restored volume. This snapshot is the restore point for anything that predates the cutover. A copy is in the backup bucket as `warren/supabase-archive-2026-07-13.dump`.

#### The cutover checklist (warren-c4b7)

Run this at an idle window.
The tooling lives in `scripts/pg-migrate/`: `dump.ts`, `restore.ts`, and `parity.ts` (tests beside them).
Every step is reversible until step 6.

1. **Idle check.** Confirm no work is in flight: `kubectl -n warren-runs get pods` shows nothing non-terminal, and the warren HTTP log is quiet.
2. **Scale warren to 0.** `kubectl -n warren scale deploy/warren --replicas=0`. The database now has no warren writers. Run pods keep working. They talk to warren over HTTP and never to the DB.
3. **Dump.** `SOURCE_DB_URL=<supabase-url> bun run scripts/pg-migrate/dump.ts`. The script writes a dated `-Fc` archive of the `public` and `drizzle` schemas with `--no-owner --no-privileges`, prints the archive size, and lists the tables from `pg_restore --list`. Read that table list before moving on.
4. **Restore.** `TARGET_DB_URL=<in-cluster-dsn> bun run scripts/pg-migrate/restore.ts <dump-file>`. The script refuses to run while the target has live connections other than its own.
5. **Parity.** `SOURCE_DB_URL=<supabase-url> TARGET_DB_URL=<in-cluster-dsn> bun run scripts/pg-migrate/parity.ts`. It compares per-table row counts, `max(events.id)`, `max(runs.created_at)`, and the drizzle journal hash list, then exits non-zero with a diff table on any mismatch. Do not proceed on red.
6. **Rewrite the DB URL.** Point `warren-secrets/warren-db-url` at `postgres://warren:<pw>@postgres.warren.svc:5432/warren` with no sslmode flags, because traffic never leaves the cluster network. Re-apply the secret:
   `kubectl -n warren create secret generic warren-secrets --from-literal=warren-db-url='postgres://...' --dry-run=client -o yaml | kubectl apply -f -`.
7. **Scale up.** `kubectl -n warren scale deploy/warren --replicas=1`, then wait on `kubectl -n warren rollout status deploy/warren`.
8. **Smoke dispatch.** Dispatch one run and watch it reach a terminal state. Confirm events stream and the delivery path works.
9. **Rollback (if needed).** Swap `warren-secrets/warren-db-url` back to the source DSN and scale up again. Steps 2 to 8 never write to the source, so it stays intact as a rollback anchor until you decommission it. The operator deleted the Supabase source the same day as the 2026-09-03 cutover. The archived dumps above are now the only restore path for that data.

### 1.6 Automated CI/CD (GitHub Actions)

`.github/workflows/deploy-gke.yml` automates §1.2 (build and push) and §1.3 (apply).
A GKE roll-forward thus never needs `build-images.sh` plus `kubectl apply -k` by hand (warren-bd79).
The manual flow above stays the break-glass fallback, and it is the only path for kind/k3d local dev (§1.4).

**Build and push** (the `build-push` job).
The job runs when `release.yml` calls this workflow after it cuts a release (`workflow_call`, pinned to the released SHA), and on a manual dispatch.
There is deliberately **no push trigger** (warren-8b5f).
A push to `main` used to build, the release from that same push then called this workflow again, and thus every release built twice.

The job builds all four images with `docker buildx --platform linux/amd64` — Autopilot is amd64, and arm64 CrashLoops with `exec format error`.
The images are: root `Dockerfile` → `warren`, `deploy/docker/Dockerfile.agent` → `warren-agent`, and `deploy/docker/Dockerfile.workspace-init` → `warren-workspace-init`.
The fourth image is `extensions/judge/Dockerfile` → `warren-ext-judge` (warren-eecb), built from the extension directory alone.
The job tags each image with the full commit SHA **and** `latest`.
It pushes to the same `<region>-docker.pkg.dev/<project>/<repo>` Artifact Registry that `cloudbuild.yaml` targets.
The layer cache is GHA-scoped per image.

**Deploy** (the `deploy` job).
The job runs only when a caller opts in via the `deploy` input.
`release.yml` sets that input after it publishes a release, or a manual dispatch ticks it.
A branch push never deploys by itself.

The job pulls cluster credentials (`get-gke-credentials`).
The job then renders the gitignored `gke-live` overlay *on the runner* (never committed — see `.gitignore`), layered on the committed `gke` template.
The render pins all three images to the commit SHA: control-plane image via kustomize `images:`, agent and init images via the Deployment env patch.
Then `kubectl apply -k` runs, with a `rollout status` gate after it.
That render is exactly the documented `gke-live` pattern (`deploy/k8s/overlays/gke/kustomization.yaml` header), produced from CI vars instead of a hand-maintained local overlay.

**Post-deploy checks** close the warren rollout with two assertions, both fatal.
First, the rolled-out control-plane image must be the exact SHA the job just built.
Second, on the release path, the job polls `GET https://$WARREN_INGRESS_HOST/version` until it reports the released semver.
That poll proves that the ingress serves the new code, not just that the Deployment spec points at it (warren-8b5f).

**Judge extension roll** (warren-eecb) closes the job.
If a `judge` Deployment exists in the `warren` namespace, the job moves it to `warren-ext-judge:<sha>` with `kubectl set image`.
The job then waits for the rollout and verifies the live image against the built SHA.
`set image` touches only the image.
The operator's provider/model/budget env and the imperative Secrets, both owned by the gitignored `gke-live-judge` overlay, stay as deployed.
If no judge Deployment exists, the step skips — the judge is opt-in, and CI never creates it.

After a CI roll, refresh the local overlay's `newTag` from the live Deployment before any manual `kubectl apply -k`.
A stale manual apply rolls the image back (the warren-0028 hazard).

Auth is **GCP Workload Identity Federation** (`google-github-actions/auth`) — no long-lived JSON service-account keys.
A repo admin must configure:

| Kind | Name | Meaning |
|---|---|---|
| secret | `GCP_WORKLOAD_IDENTITY_PROVIDER` | full WIF provider resource (`projects/<num>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`) |
| secret | `GCP_SERVICE_ACCOUNT` | deployer SA email; needs `roles/artifactregistry.writer` + `roles/container.developer` and a WIF binding to this repo |
| var | `GCP_PROJECT_ID` | GCP project (for example `warren-502318`) — **required** |
| var | `GCP_REGION` | Artifact Registry / cluster region (default `us-west1`) |
| var | `GCP_AR_REPO` | Artifact Registry repo name (default `warren`) |
| var | `GKE_CLUSTER` | Autopilot cluster name (default `warren`) |
| var | `GKE_LOCATION` | cluster location (default `GCP_REGION`) |
| var | `WARREN_GIT_AUTHOR_EMAIL` | agent-commit author (`<id>+warren@users.noreply.github.com`); defaults to a noreply address if unset |
| var | `WARREN_INGRESS_HOST` | public hostname; patches the Ingress host + ManagedCertificate domain (both placeholders in the committed template) and is the target of the post-deploy `/version` smoke test. Optional for a build-only dispatch; **required** on the release path, which fails without it |

This workflow is the only deploy pipeline.
`release.yml` calls this workflow directly (`workflow_call`) after it publishes a GitHub release, and passes the released commit SHA.
The call builds the SHA-pinned images and rolls the cluster forward.

We deliberately avoid a `release: [published]` trigger.
GitHub suppresses workflow runs for events that the default `GITHUB_TOKEN` creates, and releases come from that token.
So that trigger would never fire (warren-cb81).
There is no Fly.io deploy (warren-b65c removed it).

### 1.7 Edge abuse control — Cloud Armor (warren-48d3)

Warren has **no per-IP HTTP rate limit in application code**.
The 429s the app can emit belong to a different layer: dispatch admission (§5.5) and the event-stream caps (`src/server/stream-limits.ts`).

A Cloud Armor policy on the load balancer absorbs volumetric L3/L7 abuse, so the abuse never reaches the single-replica control plane's CPU.

Cloudflare cannot do this job for `warren.run`.
The DNS record must stay **DNS-only / grey-cloud**, or Google's HTTP-01 `ManagedCertificate` validation fails (`deploy/k8s/overlays/gke/managedcertificate.yaml`).
Grey-cloud means no Cloudflare WAF and no Cloudflare rate limit — hence Cloud Armor.

**Two halves, both required.** A Cloud Armor policy is a GCP *project* resource, so only the attachment is a manifest:

| Half | Where | Applied by |
|---|---|---|
| the rules | `deploy/gcp/cloud-armor.sh` | `deploy/gcp/cloud-armor.sh --project $PROJECT_ID` (idempotent; `--dry-run` prints the calls) |
| the attachment | `deploy/k8s/overlays/gke/backendconfig.yaml` + the Service's `cloud.google.com/backend-config` annotation | `kubectl apply -k` (the normal deploy) |

Run the script **before** the first apply.
The `BackendConfig` reference is inert until the named policy exists, and neither `kubectl apply` nor the Ingress controller complains about a missing policy.

```bash
deploy/gcp/cloud-armor.sh --project "$PROJECT_ID"

# Confirm the policy reached the LB backend (the acceptance check):
gcloud compute backend-services list --global \
  --format='table(name,securityPolicy)'
```

**Rules and thresholds** (`warren-armor`):

| Priority | Rule | Action | Why this threshold |
|---|---|---|---|
| 1000 | per-IP rate limit, 600 req / 60s, 300s ban | `rate-based-ban`, exceed → `deny-429` | 10 rps sustained per IP. A first SPA load is ~10 requests, so this is ~2 orders of magnitude above a real user. Banning (not throttling) means a flood stops being evaluated request-by-request. |
| 2000 | `protocolattack-v33-stable` sensitivity 1 | `deny-403` | matches HTTP framing (request smuggling, header injection), never a payload |
| 2100 | `scannerdetection-v33-stable` sensitivity 1 | `deny-403` | matches known scanner UAs/paths |
| 9000–9300 | `sqli` / `xss` / `rce` / `lfi` v33-stable | `deny-403` **`--preview`** | log-only on purpose — see below |

**Why the injection rule sets are preview-only.**
Warren's request bodies are agent prompts and rendered agent JSON: arbitrary prose, shell, SQL, and HTML by design.
A prompt that says *"drop table users"* is a legitimate dispatch.

To enforce `sqli`/`xss`/`rce`/`lfi` would 403 real work, so those rule sets run in preview.
Preview mode gives forensic signal and a measurable false-positive rate.
`scripts/cloud-armor.test.ts` fails if anyone drops the `--preview` flag.

**Rule 1000 does not touch event streams.**
Two independent reasons, both worth a re-check after any change here:

- Cloud Armor rate limits count **requests**, not bytes or seconds. A long-lived `GET /runs/:id/events` NDJSON stream costs one request at open. Rule 1000 never re-counts the stream and never severs it.
- The GCE backend-service timeout defaults to **30s**, which *would* sever every stream. `backendconfig.yaml` sets `timeoutSec: 3600`. Check after a deploy: watch a run for more than 30s in the UI, or run `curl -N -H "Authorization: Bearer $TOK" https://$HOST/runs/$ID/events` against a **live** run. Since warren-7bff the bare request follows a non-terminal run by default. The connection must stay open and stream new events until the run finishes. A replay-then-close in under a second against a `state=running` run is the warren-7bff regression. Pass `?follow=0` to force replay-then-close.

**Tuning.** Thresholds are env overrides on the script — re-run it to reconcile:

```bash
WARREN_ARMOR_RATE_LIMIT_COUNT=1200 WARREN_ARMOR_BAN_DURATION_SEC=120 \
  deploy/gcp/cloud-armor.sh --project "$PROJECT_ID"
```

When a shared egress IP gets banned, raise the **count**, not the interval width — `--enforce-on-key=IP` groups everyone behind one NAT.
That key is only correct while DNS stays unproxied.
If a proxy ever sits in front of the LB, every request keys off the proxy's address.
The rule must then move to `--enforce-on-key=XFF-IP`.

The per-client event-stream cap has the same keying problem in-process (warren-46a7): GCLB appends `<client-ip>, <lb-ip>` after whatever X-Forwarded-For the caller supplied, so the left-most hop is client-forgeable.
`eventStreamClientKey` therefore counts from the right, skipping `WARREN_EVENT_STREAM_TRUSTED_PROXY_HOPS` infrastructure hops — the GKE overlay pins it to `1` (the LB's own address).
If a proxy ever sits in front of the LB, raise it by the hops that proxy appends — otherwise every spectator shares one per-client allowance.

**Do not burst-test from your own network.** The warren-63e4 synthetic burst verification trips rule 1000 exactly as designed — and the 300s ban then applies to *your* IP too.
Your own browser gets 429s off the UI and API for five minutes, mid-verification.
Run the burst from an external vantage point instead (Cloud Shell is the cheap one), or accept the self-lockout.

If you do lock yourself out, port-forward past the load balancer — Cloud Armor evaluates at the LB, and the pod never sees its 429:

```bash
kubectl port-forward -n warren deploy/warren 8080:8080
# UI and API now on http://localhost:8080 for the rest of the ban window
```

For go-live verification, pre-clear your IP with a temporary higher-priority allow rule (priority 500 sits above rule 1000):

```bash
gcloud compute security-policies rules create 500 \
  --security-policy=warren-armor --src-ip-ranges="$OPERATOR_IP/32" \
  --action=allow --project "$PROJECT_ID"

# After verification, delete it — a standing allow rule bypasses the rate limit forever.
gcloud compute security-policies rules delete 500 \
  --security-policy=warren-armor --project "$PROJECT_ID"
```

**Kill switch** (fastest first):

```bash
# 1. Detach the policy from the backend entirely (~1-2 min to take effect).
kubectl -n warren patch backendconfig warren --type=merge \
  -p '{"spec":{"securityPolicy":{"name":""}}}'

# 2. Or neutralize one rule without detaching (rule 1000 = the rate limit).
gcloud compute security-policies rules update 1000 \
  --security-policy=warren-armor --preview --project "$PROJECT_ID"

# 3. Unban a single IP that got caught: drop its ban by lowering the duration,
#    or allow-list it above the rate limit.
gcloud compute security-policies rules create 500 \
  --security-policy=warren-armor --src-ip-ranges=203.0.113.7/32 \
  --action=allow --project "$PROJECT_ID"
```

Option 1 is a **live edit** — the next `kubectl apply -k` restores the reference.
A durable disable means an edit to `backendconfig.yaml`.

**Observability.** Cloud Armor decisions ride on LB request logs.
`backendconfig.yaml` turns those logs on (`logging.enable: true`, full sample rate).
Lower the sample rate if log volume becomes a cost problem during a spike.

```bash
# Enforced denials
gcloud logging read \
  'jsonPayload.enforcedSecurityPolicy.outcome="DENY"' --limit=20 --freshness=1h

# Preview-rule matches — the false-positive rate for the 9000-series
gcloud logging read \
  'jsonPayload.previewSecurityPolicy.outcome="DENY"' --limit=20 --freshness=1h
```

**Budget alerts.** The GCP project holds live `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` values in `warren-secrets`.
An abuse spike bills through Autopilot pods and Anthropic usage before anyone notices.
Set a project budget alert once (the command needs the billing account id, so it stays manual):

```bash
gcloud billing accounts list
gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT_ID" \
  --display-name="warren monthly" \
  --budget-amount=200USD \
  --filter-projects="projects/$PROJECT_ID" \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0
```

Anthropic bills its own spend, not GCP — set a separate limit in the Anthropic console.
Warren's own per-run cost rollup (`/analytics/cost`) is operator-gated and is the in-app view of the same problem.

---

## 2. Secrets

### 2.1 What exists and where

Two namespaces hold secrets — the run namespace deliberately gets a smaller credential set than the control plane.

| Secret / key | Namespace | Consumed as | Purpose |
|---|---|---|---|
| `warren-secrets/warren-api-token` | `warren` | `WARREN_API_TOKEN` | persisted operator bearer and signing seed for derived run callback tokens and preview cookies |
| `warren-secrets/warren-db-url` | `warren` | `WARREN_DB_URL` | Postgres DSN (omit → SQLite on `warren-data`) |
| `warren-secrets/github-token` | `warren` | `GITHUB_TOKEN` | control-plane git push / private clone |
| `warren-secrets/anthropic-api-key` | `warren` | `ANTHROPIC_API_KEY` | injected into agent pod env at dispatch |
| `warren-secrets/sentry-dsn` | `warren` | `SENTRY_DSN` | error reporting (optional) |
| `warren-secrets/warren-auth` | `warren` | `WARREN_AUTH` | auth posture: `token` (default) or `public`; **not a secret** — it lives here so the flip and the revert stay a Secret edit plus a rollout restart |
| `warren-secrets/warren-public-allowlist` | `warren` | `WARREN_PUBLIC_ALLOWLIST` | comma-separated owners (`my-org`) and/or repos (`some-owner/some-repo`) a public instance may hold; read **only** under `WARREN_AUTH=public`, where an empty value refuses the boot |
| `warren-git-token/token` | `warren-runs` | `WARREN_GIT_TOKEN` (init pod) | optional init clone/push token. A private-repo run reaches `Init:Error` without it. |
| `warren-anthropic-key/api-key` | `warren-runs` | agent pod `secretKeyRef` | OPTIONAL agent key source (`WARREN_K8S_ANTHROPIC_SECRET_NAME`/`_KEY`); a run whose key rides the dispatch env still schedules when this Secret is absent |

`base/secrets.yaml` ships **placeholder templates** so that `kustomize build` resolves — never `kubectl apply` it as-is.
Create secrets imperatively.
The exact `kubectl create secret generic` commands are in [`deploy/k8s/README.md`](../deploy/k8s/README.md) ("Secrets — never commit real values").

### 2.2 The `warren-runs` isolation boundary

Run pods receive the agent key, an init Git token, and a derived callback bearer. The callback bearer uses the `WARREN_API_TOKEN` env name inside the pod.

That callback bearer is not the persisted operator token. It is bound to one live run and reaches that run's inbox, finalize, and salvage routes. This scope does not yet admit App-mode K8s credential remint. `warren-5a5c` tracks that gap.

Run pods do **not** get the DB URL. They cannot read Secrets from the K8s API because the RBAC Role grants no `secrets` verb (§4). The control plane stamps permitted credentials into the pod spec as env values.

### 2.3 Rotation

There is one persisted operator bearer token. Warren derives narrower per-run callback tokens from it (see [SECURITY.md](../SECURITY.md)).

- **`WARREN_API_TOKEN`.** Rotating the operator secret invalidates derived callback tokens for in-flight runs and every preview cookie. Rotate during a quiet window: update `warren-secrets`, then `kubectl -n warren rollout restart deploy/warren`. In-flight run pods hold callback tokens signed with the old secret, so their finalize callback will fail. Drain first (§7.6), or accept that active runs reap degraded.
- **`GITHUB_TOKEN` / `WARREN_GIT_TOKEN`.** Update both copies — the control-plane `warren-secrets/github-token` and the run-namespace `warren-git-token/token` are the same PAT by convention. Rollout-restart the control plane. New run pods pick the new value up at the next dispatch. Old pods keep the token in their spec until they exit.
- **`ANTHROPIC_API_KEY`.** Update `warren-secrets` (the control-plane env source) and the optional `warren-anthropic-key` if you use the `secretKeyRef` path. Rollout-restart.

Rotation is coarse (edit the Secret, restart) because V1 has no token expiry or scopes.
The restart is not optional. The public event stream builds its secret-literal matcher from `process.env` once, at the first public event, and never rebuilds it. Rotate any secret that reaches warren via env, then restart warren. Until the restart, public event projections do not redact the new value.

GitHub App mode ships short-lived installation tokens, minted per operation. Set `WARREN_FORGE=app` and follow §2.6.
[ROADMAP.md](../ROADMAP.md) defers per-user identity until paid — the deployment, not the user account, is warren's unit of trust.

### 2.4 Secrets you must NOT set under k8s

`BURROW_API_TOKEN`, `WARREN_BURROW_TOKEN`, `BURROW_DATA_DIR`, and the four bwrap security overrides are LocalProvider-only.
Nothing reads them under `WARREN_RUNTIME=k8s`, so in the cluster they are dead weight that causes confusion.
Do not `--from-env-file` a self-host `.env` straight into `warren-secrets` — cherry-pick the keys in the table above.

### 2.5 The public-instance posture

`WARREN_AUTH` selects who may reach the instance without a bearer token.
The default `token` keeps every route gated.
`public` admits credential-less spectators to a read-only public projection covering runs, projects, agents and the event stream.
`WARREN_PUBLIC_ALLOWLIST` names what such an instance may hold.
Each entry is either a bare owner (`my-org`) or one repo (`some-owner/some-repo`).
Use repo entries when the owner also holds private repos, because an owner entry admits every repo beneath it.

Neither value is a credential.
Both live in `warren-secrets` for one reason: rollback speed.
An operator flips the posture, and reverts it, with a Secret edit plus a rollout restart.
A literal `value:` in the overlay would turn that revert into a commit, a release and a deploy.

```bash
kubectl -n warren patch secret warren-secrets --type merge -p \
  '{"stringData":{"warren-auth":"public","warren-public-allowlist":"<owner>|<owner>/<repo>[,...]"}}'
kubectl -n warren rollout restart deploy/warren
```

To revert, set `warren-auth` back to `token` and restart again.
The Secret edit alone changes nothing, because a `secretKeyRef` resolves at pod start.

Both keys fail safe.
An absent or blank `WARREN_AUTH` resolves to `token`, and an unrecognized value refuses the boot outright.
No degenerate value ever reaches `public`.
Public mode with an empty allowlist also refuses the boot, and a rolling update never routes traffic to a pod that fails to start.
A misconfigured flip therefore leaves the previous pod in service rather than exposing one.

The allowlist proves the OWNER, not that each repo under it is public.
Put an org on the list only when you accept every repo in it becoming visible.
`scripts/public-auth-wiring.test.ts` guards the wiring that carries both keys into the container.

### 2.6 GitHub App mode (`WARREN_FORGE=app`)

App mode replaces the static PAT with short-lived installation tokens.
The control plane mints a token per operation and re-mints it on expiry (design: [`docs/design/forge-contract.md`](design/forge-contract.md) §4).
No bearer token ever sits on a config object.
The only long-lived secret is the App's PEM private key.
A misconfigured value fails the boot loudly, never silently at first dispatch.

**Register the App (once).** Open `GET /github-app/register` in a browser that can reach the warren UI.
You need no bearer token.

The registration surface sits behind an existence gate (warren-e320), and a gated-off route answers 404.
Set `WARREN_GITHUB_APP_REGISTRATION=on` or `=off` to override the gate outright.
The default derives fail-safe: OFF under `WARREN_AUTH=public`, OFF once `WARREN_FORGE=app` holds working credentials, and ON only for a private instance without App credentials.
That last case is the first-boot flow the surface exists for.
Boot logs the resolved verdict, so you can see why the surface is or is not there.

The page shows the exact manifest (contents and pull-requests write, checks read, private visibility) and one button that hands it to GitHub's create-App flow.

GitHub then redirects back to `/github-app/callback`.
The callback converts the single-use code with no authentication and renders the credential set once: App id, slug, client id and secret, and the PEM private key.

Warren stores nothing, so copy the values into your secret store from that page.
For an organization-owned App, use `/github-app/register?org=<login>`.

**Install the App.** The credentials page links to `https://github.com/apps/<slug>/installations/new`.
Install the App on the account or repositories warren may touch.
Then read the installation id from the URL GitHub lands on (`.../settings/installations/<id>`).

**Supply the credentials.** Add these keys to `warren-secrets` (or to the env of a non-k8s deploy) and rollout-restart:

| Secret key | Env var | Value |
|---|---|---|
| `warren-forge` | `WARREN_FORGE` | `app` |
| `github-app-id` | `WARREN_GITHUB_APP_ID` | the App id from the callback page |
| `github-app-installation-id` | `WARREN_GITHUB_APP_INSTALLATION_ID` | from the install step above |
| `github-app-private-key` | `WARREN_GITHUB_APP_PRIVATE_KEY` | the PEM, verbatim (warren unfolds literal `\n` sequences if your store needs the single-line form) |

From then on the control plane mints installation tokens from the cached triple.
The static `GITHUB_TOKEN` is no longer the forge credential.

**Update the auto-merge bot login (migrating from PAT mode).** On every repo warren dispatches against, set the `AUTO_MERGE_BOT_LOGIN` repository variable to the App's `<slug>[bot]` login (for example `warren-forge-abc123[bot]`), replacing the old PAT account's login. Under App mode the App's bot identity authors agent PRs, and the auto-merge workflow's enable-auto-merge job matches the PR author login against this variable. Leave it on the PAT login and the job silently skips every agent PR with no error surfaced.

---

## 3. Control-plane configuration (env)

The Deployment env below turns on and tunes the K8s backend.
Manifest values live in `deploy/k8s/base/deployment.yaml` plus the overlays.

| Env | Value / default | Meaning |
|---|---|---|
| `WARREN_RUNTIME` | `k8s` | selects `K8sProvider` (default `local`) |
| `WARREN_K8S_NAMESPACE` | `warren-runs` | namespace run pods land in |
| `WARREN_K8S_AGENT_IMAGE` / `WARREN_K8S_INIT_IMAGE` | registry paths | the run pod + init images (§1.2). Per-project override: a project's `.warren/config.yaml` `agentImage` pins its own run-pod image — precedence: project `agentImage` > `WARREN_K8S_AGENT_IMAGE` > default (warren-fabb; the init image is not overridable) |
| `WARREN_K8S_CALLBACK_SERVICE` / `_NAMESPACE` / `_PORT` | `warren` / `warren` / `8080` | the in-pod callback URL = Service DNS `warren.warren.svc.cluster.local:8080` (provider-owned; do not set `WARREN_API_URL` by hand) |
| `WARREN_K8S_REPO_CACHE_PVC` | unset (cache OFF by default, warren-554f) | opt-in: names the shared repo-cache claim; set it (plus the PVC) via an overlay — or, on the deploy-gke pipeline, via the repo variable of the same name (warren-8175) — see §5.3 |
| `WARREN_K8S_REPO_CACHE_PATH` | `/repo-cache` | mount path for the cache |
| `WARREN_K8S_MAX_QUEUE_DEPTH` | `50` | admission: total non-terminal pods; `0` disables (§5.5) |
| `WARREN_K8S_MAX_PENDING_PODS` | `20` | admission: Pending pods; `0` disables |
| `WARREN_K8S_MAX_PROJECT_CONCURRENCY` | unset (unlimited) | admission: global per-project default |
| `WARREN_K8S_ANTHROPIC_SECRET_NAME` / `_KEY` | `warren-anthropic-key` / `api-key` | optional agent-key `secretKeyRef` |
| `WARREN_K8S_GIT_SECRET_NAME` / `_KEY` | `warren-git-token` / `token` | init-container git token source |
| `WARREN_K8S_EPHEMERAL_STORAGE_REQUEST_MIB` / `_LIMIT_MIB` | `10240` / `10240` (10Gi) | cluster-wide default ephemeral-storage budget (request + limit + emptyDir `sizeLimit`). A per-project `resources` block beats it (§7.3.1) |
| `WARREN_K8S_MEMORY_REQUEST_MIB` / `_LIMIT_MIB` | `2048` / `4096` | cluster-wide default memory budget; a per-project `resources` block beats it. On the deploy-gke pipeline, set via the repo variables of the same names (warren-ff6f) — the render step re-wires the env on each deploy so the sizing survives releases |
| `WARREN_K8S_CPU_REQUEST_MILLICORES` / `_LIMIT_MILLICORES` | `1000` / `4000` | cluster-wide default cpu budget; a per-project `resources` block beats it. Lower the request on a small node (a two-core laptop VM never schedules the 1-CPU default) |
| `WARREN_K8S_SPOT` | unset (On-Demand) | run pods only: pin every run pod onto GKE Autopilot Spot nodes (`nodeSelector cloud.google.com/gke-spot=true` plus the matching NoSchedule toleration, warren-2e2e). Truthy values are exactly `1`/`true` (case-insensitive); anything else stays off. Never applies to the control-plane Deployment. On the deploy-gke pipeline, set via the repo variable of the same name (warren-ff6f). See "Spot run pods" below |
| `WARREN_AUTH` | unset ⇒ `token` | auth posture (§2.5); `public` admits credential-less spectators to the public projection |
| `WARREN_PUBLIC_ALLOWLIST` | unset | owners and/or `owner/repo` entries a public instance may hold; required under `WARREN_AUTH=public` |
| `WARREN_GITHUB_APP_REGISTRATION` | unset (fail-safe default, §2.6) | existence gate for the `/github-app/*` registration surface (warren-e320). `on`/`off` overrides the default. Gated-off routes answer 404 |
| `WARREN_JUDGE_BASE_URL` | `http://judge.warren.svc.cluster.local:8080` | base URL of the judge extension Service; with the token below it enables the server-side `GET /verdicts.jsonl` proxy (the judge Service stays cluster-internal — the browser only talks to warren). Set in `deploy/k8s/base/deployment.yaml` |
| `WARREN_JUDGE_EXPORT_TOKEN` | from `judge-secrets/judge-export-token` (optional) | bearer credential the proxy presents to the judge's export endpoint (`deploy/k8s/extensions/judge/secrets.yaml`). Both knobs unset ⇒ the surface is disabled |

The provider injects these into pods (never set them by hand): `WARREN_API_URL`, `WARREN_RUN_ID`, `WARREN_REPO_URL`, `WARREN_BRANCH`, `WARREN_BASE_BRANCH`, `WARREN_WORKSPACE_PATH`, `WARREN_SEED_MANIFEST`.

#### Spot run pods (warren-2e2e)

Setting `WARREN_K8S_SPOT=true` opts every **run pod** into GKE Autopilot Spot capacity. `buildRunPod` adds `nodeSelector: {"cloud.google.com/gke-spot": "true"}` plus the toleration `{key: cloud.google.com/gke-spot, operator: Equal, value: "true", effect: NoSchedule}`. Run pods suit this placement: they are ephemeral and retry-safe. The trade:

- Spot pods cost 60–91% less but the cluster can preempt them. Autopilot sends a **25 s** preemption signal before it reclaims the node.
- A preemption counts as an infra-lost retry, not a failure of the work. The preemption classification treats it as retryable and the run re-dispatches from scratch. The model spend of the aborted attempt is the real cost of the trade. The run's `maxCostUsd` cap bounds it.
- `terminationGracePeriodSeconds` stays at the K8s 30 s default. We do not raise it for Spot. Preemption ends the pod as lost whatever the grace says, and the run re-dispatches, so a longer grace buys nothing. Explicit `cancel()` controls its grace separately through `WARREN_K8S_CANCEL_GRACE_SECONDS` (a delete-request `gracePeriodSeconds`, independent of the 25 s notice).
- The control plane stays on On-Demand. The Deployment manifests under `deploy/k8s/` do not read this knob, so warren itself never lands on preemptible capacity.

---

## 4. RBAC — what the Role grants and why

The control-plane ServiceAccount (`warren` in namespace `warren`) gets a `Role` plus `RoleBinding` in `warren-runs` **only** — no ClusterRole, no cluster-wide grant (`deploy/k8s/base/rbac.yaml`, design Q4 / R5).
The verbs are exactly what `src/runtime/k8s/` exercises:

| Resource | Verbs | Why |
|---|---|---|
| `pods` | `get, list, watch, create, delete` | dispatch (create), the pod-watcher informer (list/watch), status reads (get), reap + GC (delete) |
| `pods/log` | `get, watch` | the pod-log NDJSON event stream (§6.1 / §5.1) |
| `configmaps` | `get, list, create, delete` | per-run seed-file ConfigMaps — create at dispatch, list/delete at GC |
| `events` | `list, watch` | the pod-warning-events watcher (`src/runtime/k8s/pod-event-watcher.ts`, warren-32f8) list-watches core Events to surface `FailedScheduling`, `FailedAttachVolume`, and image-pull stalls on the run's event stream. Without it the watcher reconnects on 403 forever |

Two verb families are absent on purpose:

- No `update` or `patch` — warren replaces objects, and never mutates them in place.
- No `secrets` read — the control plane injects agent secrets as pod env, and run pods never read them from the API. That is the §2.2 blast-radius boundary.

Check the grants on any cluster:

```bash
kubectl auth can-i --as=system:serviceaccount:warren:warren \
  create pods -n warren-runs          # → yes
kubectl auth can-i --as=system:serviceaccount:warren:warren \
  get secrets -n warren-runs          # → no
kubectl auth can-i --as=system:serviceaccount:warren:warren \
  create pods -n default              # → no (namespace-scoped)
```

If dispatch fails with a `403 Forbidden` from the K8s API, check this Role first.
A missing verb shows up as pods that never get created, or as an informer that never attaches.
`configmaps`, `watch`, and `events` are the common gaps — the plan text under-specified them.

### 4.1 NetworkPolicy — run-pod egress contract (warren-8dbb)

`deploy/k8s/base/networkpolicy.yaml` is the network-layer backstop for every
warren-managed run pod (`warren.io/managed-by=warren`).

Without a NetworkPolicy-capable CNI these objects are inert no-ops and the
cluster keeps the flat-pod behaviour. With one (kind + Calico/Cilium, GKE
Dataplane V2, most managed clusters) they take effect on apply.

Live validation on kind and GKE is an operator follow-up. This tree only ships
the manifests and offline-renders them via `kubectl kustomize`.

Four policies ship, all in `warren-runs`:

| Policy | Selects | Effect |
|---|---|---|
| `warren-runs-default-deny-ingress` | `warren.io/managed-by=warren` | **Deny all ingress.** Run pods are clients only — nothing (peer run pods, the control-plane pod network, anything else) should dial them. `kubectl logs`/`exec` ride the apiserver→kubelet path and are unaffected. |
| `warren-runs-restricted-egress` | `warren.io/network=restricted` (the project default, `DEFAULT_K8S_NETWORK`) | **Coarse egress allowlist** — see contract below. |
| `warren-runs-none-egress` | `warren.io/network=none` | **Deny all egress.** Mirrors LocalProvider/bwrap unshared-net and DockerProvider `--network none`. |
| `warren-runs-open-egress` | `warren.io/network=open` | **Allow all egress.** Explicit so a future namespace-wide default-deny egress an operator adds does not surprise an `open` run. Ingress stays denied. |

**`restricted` egress contract** (what a default run pod may dial):

1. **DNS** — UDP/TCP port 53 to any destination. CoreDNS / kube-dns placement
   differs across kind, k3d, and GKE. Pinning a namespace/podSelector would break
   one of them, so the port alone is the allow.
2. **Warren control-plane Service** — TCP 8080 to pods in namespace `warren`
   labelled `app.kubernetes.io/name=warren,app.kubernetes.io/component=control-plane`.
   This is the in-cluster callback (`http://warren.warren.svc.cluster.local:8080`)
   the agent uses for events, inbox, and finalize. If you rename the control-plane
   namespace or labels, update this rule in lockstep with
   `WARREN_K8S_CALLBACK_*` / `pod-spec.ts`.
3. **External world** — `0.0.0.0/0`. Git clone/push, model providers, and package
   registries all leave the cluster. **No CIDR or FQDN pin** ships in-tree.
   GitHub and provider ranges move, and FQDN-based policy needs Cilium or GKE
   Dataplane V2. That tightening is operator territory at release time — widen
   or narrow this rule in a live overlay, never by guessing CIDRs into base.

What the policy set deliberately does **not** cover:

- The control-plane pod in namespace `warren` (Ingress, ServiceMonitor, and
  operator traffic stay unrestricted).
- Per-domain allowlisting (`networkPolicy: "coarse"` in
  `K8S_PROVIDER_CAPABILITIES` — see §8).
- IPv6 egress (`::/0`). Add it in a live overlay if the cluster is dual-stack
  and agents need it.

Sanity checks after apply:

```bash
kubectl -n warren-runs get networkpolicy
# A running restricted pod should resolve DNS, reach the warren Service on :8080,
# and reach an external host (e.g. api.github.com). It must NOT accept a connect
# from another run pod:
kubectl -n warren-runs get pods -l warren.io/managed-by=warren -o wide
# (from a debug pod in warren-runs) nc -zv <run-pod-ip> 1-65535  → times out
```

### 4.2 In-pod entrypoint/agent uid split (warren-cb93)

Every run pod's agent container runs warren's entrypoint (pid 1, uid 1000)
and the agent process under a second uid (`WARREN_POD_AGENT_UID` = 1001, gid
stays 1000). The entrypoint wraps the agent argv in `setpriv`
(`src/runtime/k8s/agent-uid-drop.ts`).

The agent container carries `capabilities: add: [SETUID, SETGID, KILL]` for
the entrypoint only. setpriv empties the agent's own capability sets and
sets `no_new_privs`.

The purpose is provenance. The warren-authored marker on pod-log lines
(warren-6646) is in-band, so the agent must not be able to write at the
entrypoint's stdout fd.

A cross-uid open of `/proc/1/fd/1` fails EACCES.

The setpriv privilege comes from file capabilities (warren-950d).
containerd 2.x puts `capabilities.add` for a non-root pid 1 in the
bounding set only. A bare setpriv then fails setresuid with EPERM, exit
127. A GKE node auto-upgrade caused exactly this on 2026-08-25.

The fix has two halves:

- The agent image bakes file capabilities on the setpriv binary
  (`setcap cap_setuid,cap_setgid+ep`, `deploy/docker/Dockerfile.agent`).
- The agent container sets `allowPrivilegeEscalation: true` while the split
  is on. This keeps `no_new_privs` off for the entrypoint, which lets the
  file caps take effect on exec. The `capabilities.add` list still matters
  because file caps only grant what the bounding set contains.

The agent side cannot climb back with the same binary. setpriv runs it
under `--no-new-privs` (inherited and irrevocable — file caps are inert)
with `--bounding-set=-all` (SETUID gone from bounding regardless). Live
canary pods on GKE Autopilot / containerd 2.1.7 proved both halves.

The stdin-hold watchdog's force-kill is a cross-uid signal the entrypoint
can no longer deliver directly. It routes through the same setpriv drop
(`withCrossUidKill` in `src/runtime/k8s/agent-uid-drop.ts`).

The entrypoint pre-flights the drop before launching the agent.

When setpriv cannot gain the caps, the run fails legibly with a `uid-drop
preflight failed` system event instead of running the agent at the
entrypoint's uid. Reap finalizes it `spawn_failed` (an infrastructure
fault, warren-950d) — never `no_model_response`.

The deploy workflow gates on the split. After every rollout,
`scripts/k8s-uid-drop-canary.ts` runs the exact preflight in a canary pod
built from the run-pod builders, with the freshly built agent image.

A cluster or image that can no longer privilege the drop turns the deploy
red before any run dispatches. Run it by hand against any cluster:

```bash
bun run scripts/k8s-uid-drop-canary.ts --image <agent-image> --namespace warren-runs
```

`WARREN_K8S_AGENT_UID_DROP=0` on the control plane restores the legacy
shared-uid pod shape (and the forgeable residual). Use it only as an
escape hatch while you fix a runtime or image.

Removal procedure: deploy an agent image with the file-caps setpriv, and
run the canary above until it passes. Then run
`kubectl -n warren set env deploy/warren WARREN_K8S_AGENT_UID_DROP-` and
confirm the next run's pod log shows the `dropping agent to uid 1001` line.

Live validation (operator step: dispatch any run, wait for the pod to reach
`Running`, then substitute the pod name):

```bash
POD=$(kubectl -n warren-runs get pods -l warren.io/run-id=<run-id> -o name)

# 1. The agent process really runs as uid 1001 while pid 1 stays uid 1000:
kubectl -n warren-runs exec $POD -c agent -- \
  sh -c 'for s in /proc/[0-9]*/status; do echo "$s $(grep -E "^(Name|Uid):" $s | tr "\n" " ")"; done'
# expect: the entrypoint (bun) lines show Uid: 1000, the agent (claude/pi) shows Uid: 1001.

# 2. The marker forge FAILS from the agent's uid (EACCES = the fix working):
kubectl -n warren-runs exec $POD -c agent -- \
  setpriv --reuid=1001 --regid=1000 --clear-groups --no-new-privs \
    --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
  sh -c 'echo "{\"kind\":\"state_change\",\"origin\":\"warren\"}" > /proc/1/fd/1'
# expect: "sh: can't create /proc/1/fd/1: Permission denied", non-zero exit,
# and NOTHING appears in `kubectl logs $POD -c agent`.

# 3. The agent's real work still functions under the split (group-writable
#    workspace, uid-agnostic git safe.directory, readable bun global store):
kubectl -n warren-runs exec $POD -c agent -- \
  setpriv --reuid=1001 --regid=1000 --clear-groups --no-new-privs \
    --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
    sh -c 'touch /workspace/.uid-split-ok && rm /workspace/.uid-split-ok \
      && git -C /workspace status --short \
      && git -C /workspace -c user.name=uidcheck -c user.email=uidcheck@invalid \
           commit --allow-empty -m uid-split-check \
      && git -C /workspace reset --soft HEAD~1 \
      && bun --version && sd --version && ml --version'
# expect: all succeed (a uid-1001 commit inside the uid-1000-owned checkout
# proves the warren-fd08 assumptions survived the split).
```

---

## 5. Garbage collection & resource growth

Three things accumulate, and each has its own reaper.
Left unbounded, they exhaust the namespace quota (§5.4) or the cache PVC.

### 5.1 Pod GC loop (terminal pods + seed ConfigMaps)

`src/runtime/k8s/pod-gc.ts` boots alongside the pod-watcher under k8s (`src/server/main/runtime-wiring.ts`).
K8s itself never reaps bare pods with `restartPolicy: Never`.
And **pod logs — the event stream's durable store — vanish when the pod goes away.**

The loop:

- Sweeps every **5 min** (`DEFAULT_GC_INTERVAL_MS`).
- Deletes pods in `Succeeded`/`Failed` phase older than **30 min** (`DEFAULT_GC_MAX_AGE_MS`, design R6). Age comes from the latest container `terminated.finishedAt`, with `creationTimestamp` as the fallback.
- Then deletes any run-labelled ConfigMap whose run-id has no kept pod behind it. That reclaims both the just-deleted pods' seed ConfigMaps and truly orphaned ones.
- Is best-effort: a single delete failure logs and skips, and never wedges the sweep. `warren_pod_gc_deletions_total{resource}` counts reclaims.

Implication: **a run's events stay queryable from the pod log for only ~30 min after the run finishes.**
But the log-follow bridge already persists them into warren's events table during the run, so the durable record survives GC.
If you need the raw pod for forensics, capture `kubectl -n warren-runs get pod <run> -o yaml` before the window closes, or lengthen the window in code.

### 5.2 `never_started` row GC (scheduler retry hygiene)

A persistently-unreachable runtime used to mint one `never_started` run row per 60s cron tick, forever (~200 rows in 3h on GKE, warren-a0a2).
The bounded cron-retry tracker (`src/triggers/cron-retry.ts`) now caps consecutive transient spawn failures at **5 per slot** (`MAX_CRON_TRANSIENT_RETRIES`, ≈ a 5-min outage window).
After the fifth failure it consumes the slot and emits `scheduler.cron_gave_up`.
Each failed attempt GC's the previous attempt's `never_started` row, so at most one such row survives per failed slot.

The counters are in-memory state, so a control-plane restart resets them.
That is acceptable — the worst case is one extra bounded burst after a restart.

### 5.3 Repo-cache (opt-in) growth

The repo-cache is **off by default** as of warren-554f.
The base has no `warren-repo-cache` PVC, and `deployment.yaml` does not set `WARREN_K8S_REPO_CACHE_PVC`, so every run clones fresh.
The claim is `ReadWriteOnce` and shared by all run pods.
Concurrent run pods on different nodes deadlock on it (Multi-Attach), and the second run stalls in Init.
Direct clones cost seconds against 5–20min runs.
RWX storage (like GKE Filestore, 1TiB minimum) costs too much to share a disk of small mirrors.

**The default init path is now a blobless partial clone** (`--filter=blob:none`, warren-3b44).
With `WARREN_K8S_REPO_CACHE_PVC` unset, `src/runtime/k8s/workspace-init.ts` clones directly with blob filtering, so the run needs no shared storage and no cache PVC.
The trade is lazy blob fetches: content-walking git operations such as `git log -p` and `git blame` fetch blobs on demand from the remote. They run slower than against a full clone.
Commits, working-tree diffs, and push/finalize behave as before.

**The Filestore RWX cache failed on cost.** The live cluster ran a `warren-repo-cache` Filestore Basic HDD instance from 2026-08-27 to 2026-09.
The Basic HDD tier starts at 1 TiB, and GKE offers no smaller RWX tier. It cost ~$200/mo to cache a 2.9 GB openclaw mirror.
The partial clone replaced it (warren-3b44), and the operator deleted the instance.
Do not re-provision Filestore for this cache.

Keep the mirror cache opt-in, sensible only for **single-node clusters with an RWO class** (the warren-554f caveat).
Single-node clusters may opt back in via an overlay that adds the claim and re-sets the env (see `deploy/k8s/README.md`, "Repo cache (opt-in)").
Before adding a second node, turn the cache back off or migrate the claim to a `ReadWriteMany` class (design R2). Check the cost record above first.

When enabled, `warren-repo-cache` is a **shared clone cache**, never a working tree — the working tree is the per-pod `emptyDir`.
The init container keeps a per-repo bare mirror at `/repo-cache` (`<sha256(url)>.git`, `git clone --mirror`, then `git fetch` on reuse).
A run then costs a `git fetch` plus a fast local clone instead of a full network clone (warren-e908, design §4.3 / R2).
The cost trade flips only when a repo is large **and** the cluster is single-node.
The live cluster's openclaw runs (~2.9GB, ~20min Init on a fresh clone in 2026-08) now use the default partial clone, not the cache.

The number of distinct repos times their object-store size bounds growth — run count does not.
If the cache fills: expand the PVC, or clear `WARREN_K8S_REPO_CACHE_PVC` to turn the cache off (runs then clone fresh — slower, with no disk growth).
A wedged or corrupt mirror never blocks a run: any cache failure falls back to a direct network clone automatically (§7.5).

Known refspec limit (warren-232d, accepted): the mirror update fetches only `refs/heads/*` and `refs/tags/*`.
A `baseCommit`-pinned run whose SHA no branch or tag reaches therefore misses the cache.
The local clone's `git checkout <sha>` fails, so the init container falls back to a direct network clone, which carries the full object store.
This costs one uncached clone for unreachable-SHA replays and preserves correctness.

### 5.4 Namespace quota (the hard backstop)

`warren-runs` carries a `ResourceQuota` (50 pods, 100 CPU / 200Gi requests, 200 CPU / 200Gi limits) plus a paired `LimitRange` (`warren-runs-defaults`).
The LimitRange is load-bearing, not decorative.
A compute ResourceQuota rejects any pod whose containers do not **all** declare requests and limits, and the `workspace-init` container declares none.
The LimitRange supplies its defaults, so the pod admits.
If you keep the quota, keep the LimitRange — otherwise every dispatch fails with `must specify requests.cpu`.
This quota is the hard ceiling behind warren's soft admission caps (§5.5).

### 5.5 Admission control knobs

Soft controls sit in front of the scheduler (`src/runtime/k8s/admission.ts`, design §3.3).
`K8sProvider.create()` evaluates them before any pod write.
Counts come off the pod-watcher snapshot — the pods *are* the queue, with no runs-table read.
A rejection throws `RuntimeAdmissionError` → **HTTP 429** plus `Retry-After: 30`, with a machine-readable `reason`.
Checks run most-specific-first:

| Reason | Knob (default) | Trips when |
|---|---|---|
| `project_concurrency_exceeded` | `.warren/config.yaml` `admission.maxConcurrentRuns`, else `WARREN_K8S_MAX_PROJECT_CONCURRENCY` (unlimited) | the dispatching project already has ≥ cap non-terminal run pods |
| `cluster_pending_saturated` | `WARREN_K8S_MAX_PENDING_PODS` (20) | ≥ cap run pods stuck `Pending` (cluster can't schedule what it has) |
| `queue_depth_exceeded` | `WARREN_K8S_MAX_QUEUE_DEPTH` (50) | ≥ cap total non-terminal run pods |

Set any knob to `0` to turn that cap off.
`warren_run_admission_rejections_total{reason}` makes rejections observable.

### 5.6 Sizing run pods on Autopilot (warren-fe11)

Autopilot **bills the request**, not the usage. A run pod's vCPU + memory
request is what the invoice sees. Idling or saturating makes no difference to
the bill.

**The 1:6.5 ratio rule.** Autopilot enforces `memory request ≤ 6.5 × vCPU
request`. When a pod asks for more memory than the ratio allows, Autopilot
*raises* the vCPU request (0.25 vCPU increments) until the ratio holds.

- Minimum requests: 0.25 vCPU / 0.5 GiB.
- **Memory limits cannot exceed requests on Autopilot** (the limit clamps to
  the request), so there is no burstable-memory gap.
- The request IS the OOM ceiling on Autopilot.

**August 2026 measurements** (Cloud Monitoring `memory/used_bytes`,
non-evictable, per-pod peak via ALIGN_MAX, namespace `warren-runs`,
2026-08-01 → 2026-09-02, supplied by the operator):

| Container | n | p50 | p90 | p95 | max |
|---|---|---|---|---|---|
| agent | 470 pods | 1129 MiB | 1494 MiB | 1623 MiB | 10234 MiB |
| workspace-init | 92 | 59 MiB | — | 390 MiB | 2310 MiB (openclaw clone) |

Agent peaks bucketed: ≤2 GiB (458 pods), 2–4 GiB (3), 4–8 GiB (7), >8 GiB (2).
All eight pods above 4 GiB belonged to the openclaw project (2.9 GB repo).

- August outcomes (~297 runs): 1 `oom_killed` and 3 evicted. The `oom_killed`
  run was openclaw, peaking at 10234 MiB under its 16384 MiB limit.
- Live overlay: `WARREN_K8S_MEMORY_REQUEST_MIB=16384` and
  `WARREN_K8S_MEMORY_LIMIT_MIB=16384`.

**Worked cost per pod-hour** (us-central1 Autopilot list rates: $0.0445/vCPU-h,
$0.0048/GiB-h):

| Request | Ratio-forced vCPU | Per pod-hour | × ~114 pod-hours/mo |
|---|---|---|---|
| 16384 MiB (live) | 2.5 vCPU (ceil of 16/6.5) | $0.1113 + $0.0768 = **$0.188** | **$21.43** |
| 4096 MiB (proposed) | 1 vCPU (4/6.5 = 0.62) | $0.0445 + $0.0192 = **$0.0637** | **$7.26** |
| 2048 MiB (lean option) | 1 vCPU | $0.0445 + $0.0096 = **$0.0541** | $6.17 |

**Proposal: 4096 MiB request / 4096 MiB limit.** Set
`WARREN_K8S_MEMORY_REQUEST_MIB=WARREN_K8S_MEMORY_LIMIT_MIB=4096`.

- Autopilot clamps the limit to the request. The separate limit env buys
  nothing there.
- It sits ~2.5× above the agent p95 (1623 MiB) and covers 98% of August pods.
- Expected delta at ~114 run-pod-hours/month: **save ~$14.2/mo (~66%)**.

**OOM risk at 4096 MiB:** 9 of 470 August pods (1.9%) peaked above it, all
openclaw. Without a per-project memory override, every openclaw run that
repeats its August peak OOM-kills.

- A per-project request override (keyed off the existing
  `.warren/config.yaml` dispatch path) would let openclaw keep a larger cap.
  That override is future work. warren-fe11 does not build it.
- The 2048 MiB option is not recommended: it sits only 26% above p90 and would
  have OOM-killed 12 August pods.

`src/runtime/k8s/pod-memory-sample.ts` (warren-fe11) stamps a one-shot
`run_pod_memory_sample` system event at K8s finalize. It carries the agent
container's last metrics.k8s.io memory reading, so future re-sizings ride
measured data.

---

## 6. Observability

### 6.1 Prometheus metrics

Warren exposes `GET /metrics` (bearer-auth).
The K8s-specific families live in `src/runtime/k8s/pod-metrics.ts`, wired via the pod-watcher.
Apply `deploy/k8s/servicemonitor.yaml` on clusters that run the Prometheus Operator.
The file stays out of the kustomize base because it needs the `monitoring.coreos.com/v1` CRD.

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

(The two `_duration_seconds` metrics render as gauges, not histograms — warren's dependency-free metrics core exposes only gauge and counter.)

### 6.2 `/readyz` per topology

`GET /readyz` (`src/server/handlers/diagnostics.ts`) runs deeper checks than the liveness `/healthz`.
It is **topology-aware**: local sandbox and stale-workspace probes only run when `resolveRuntimeKind() === "local"`, and return `[]` under k8s (warren-c128).
Without that gate, local-only checks would wrongly degrade a healthy Kubernetes control plane.
Under k8s, `/readyz` covers the database, registered agents, warren-config parsing, pod-watcher sync, preview allocation, and auth checks.

The Deployment probes point at the **auth-exempt `/healthz`**.
`/readyz` needs the bearer, so gate readiness on it only via a probe with `httpHeaders: [{name: Authorization, value: "Bearer …"}]`.
Use `/readyz` for deploy gating, not hot-path liveness.

### 6.3 Structured log events worth alerting on

One pino JSON line per event lands on stdout (`kubectl -n warren logs deploy/warren | jq`).
Alert on these:

- **`scheduler.cron_gave_up`** (error level) — a cron slot burned all 5 retries against an unreachable runtime and gave up (§5.2). Persistent recurrence means the K8s backend is unreachable or misconfigured. Investigate before every cron trigger silently stops firing.
- **`reap.pr_open_context_degraded`** — under k8s, warren rebuilds the PR body's commits and files-changed sections. It fetches the pushed run branch into the project clone under a temp ref (`refs/warren/pr-open/<runId>`, warren-ab66). This event fires when that fetch fails. The PR still opens, but with empty commit and diff sections. Occasional is tolerable — sustained recurrence means the project clone cannot fetch the run branch (token or network).
- **`reap.preview_skipped_unsupported`** — a project ships `.warren/preview.yaml`, but the K8s provider has `previewPorts: false` (Service/Ingress previews are a deferred feature), so no preview launches. Expected on k8s. Alert only if it surprises you — someone expected previews on this topology.

### 6.4 First triage commands

```bash
kubectl -n warren get pods                              # control plane Ready?
kubectl -n warren logs deploy/warren --tail=200 | jq
kubectl -n warren-runs get pods -l warren.io/run-id     # run pods + phases
kubectl -n warren-runs describe pod <run>               # events: scheduling, OOM, pull errors
```

---

## 7. Incident response playbooks

Symptom → diagnosis → remedy.
Each playbook rests on verified behavior.

### 7.1 Runtime unreachable — dispatches fail, `scheduler.cron_gave_up` recurs

**Symptom.** New runs never start.
Cron triggers log `scheduler.cron_gave_up` every slot.
A manual dispatch returns a 5xx or hangs.

**Diagnose.** Is the problem the K8s API, or the control plane?

```bash
kubectl -n warren logs deploy/warren --tail=200 | jq 'select(.level >= 50)'
kubectl auth can-i --as=system:serviceaccount:warren:warren create pods -n warren-runs
```

A `403` means an RBAC regression (§4).
A `401` off-cluster means the Bun-fetch client-cert issue (host-mode only, §1.4) — impossible for an in-cluster pod.
Connection errors mean the API server is unreachable, or the kubeconfig is wrong.

**Remedy.** Fix the RBAC binding or the kubeconfig/ServiceAccount mount, then `kubectl -n warren rollout restart deploy/warren`.
The cron-retry backoff means that triggers resume on their next slot once the runtime recovers — no manual replay.

### 7.2 Pod stuck `Pending`

**Symptom.** A run sits `queued`/`running` in warren while its pod sits `Pending`.
`warren_pod_pending_duration_seconds` climbs.
New dispatches start to return `429 cluster_pending_saturated`.

**Diagnose.**

```bash
kubectl -n warren-runs describe pod run-<id>   # Events section is authoritative
```

Common causes:

- The cluster lacks capacity for the requests — Autopilot is busy with node scale-up, so wait.
- The ResourceQuota has no free slots (§5.4).
- The image pull fails (`ErrImagePull` — wrong registry path or missing pull creds).
- The LimitRange got dropped, so the init container has no requests (`must specify requests.cpu`).

**Remedy.**

- Capacity: wait, or raise the quota.
- Quota full: the pod GC clears terminal pods at 30 min and frees slots, or raise the quota. The admission 429 protects the cluster — honor the `Retry-After`.
- Image pull: point `WARREN_K8S_AGENT_IMAGE`/`_INIT_IMAGE` at a pullable ref.
- Lost LimitRange: re-apply `resourcequota.yaml`.

### 7.3 OOMKilled runs

**Symptom.** A run flips to `failed` within seconds.
`warren_run_oom_killed_total` increments.
`describe pod` shows `Last State: Terminated, Reason: OOMKilled`.

**Diagnose.** The fast fail is by design — the kubelet killed the container at its `memory.limit`.
The pod-watcher saw `terminated.reason == OOMKilled` in ~1-2s and marked the run `failed (oom_killed)`.
The question is whether the limit is too low, or the run is a genuine runaway.
Check the prompt and the workload against the 4Gi default limit.

**Remedy.** For a legitimately heavy run, raise the per-project memory limit (`.warren/config.yaml` resources, `src/warren-config/resources-config.ts`) so that request and limit fit the workload.
On Autopilot, remember that billing follows request == limit.
For a runaway, fix the agent or the prompt — do not paper over it with a cluster-wide limit raise.
There is no blind retry: `restartPolicy: Never` means an OOM ends the pod, and warren surfaces the failure immediately instead of a re-run from scratch.

#### 7.3.1 Evicted runs (ephemeral-storage exhaustion)

**Symptom.** A run flips to `failed (evicted)`, and `warren_run_evicted_total` increments.
`describe pod` shows `Status: Failed`, `Reason: Evicted`, and the message `Pod ephemeral local storage usage exceeds the total limit of containers …`.
A container shows `Terminated, Reason: ContainerStatusUnknown, Exit Code: 137`.

**Diagnose.** The agent's `/workspace` (an emptyDir with the clone plus `bun install`) outgrew the pod's ephemeral-storage budget, and the kubelet reclaimed the pod.
The `Evicted` pod reason — not the container's `ContainerStatusUnknown` code — is the reliable witness (`src/runtime/k8s/status-map.ts`).
The run thus finalizes as `failed (evicted)` rather than a generic error.

**You do not need kubectl to read the cause (warren-4a95).**
The evicted pod — and its kubectl events — age out of the API within the hour.
Warren therefore captures the kubelet's own `status.message` at observation time, in three places.
For an ephemeral-storage eviction that message reads `Pod ephemeral local storage usage exceeds the total limit of containers 10Gi`.

1. the run's event stream — the `watchdog_terminal_reconciled` system event's `providerDetail` payload field.
2. warren's logs — the pod-watcher's `run pod evicted by kubelet` warn line (`detail` field) and the watchdog's reconcile line (`terminalDetail` field).
3. the finalize-failure message, when the pod went terminal before its finalize POST could land.

A detail that says ephemeral-storage exhaustion means the workspace outgrew the budget.
A detail that names node pressure means the node ran out of disk, and the remedy is cluster capacity rather than a bigger budget.

**On GKE Autopilot, a pod with no explicit ephemeral-storage request gets a 1Gi default.**
A real clone plus install blows past that in minutes.
Warren now sets an explicit 10Gi request and limit on BOTH the agent and workspace-init containers, plus a matching emptyDir `sizeLimit` (warren-653f).
The default budget is thus generous.

**Remedy.** For a legitimately large repo or toolchain, raise the ephemeral-storage budget.
UI builds are the classic case: a root `bun install` plus a `src/ui` install plus a Vite build can outgrow 10Gi.
Per-project, in `.warren/config.yaml`:

```yaml
resources:
  requests:
    ephemeralStorageMiB: 20480   # 20 GiB
  limits:
    ephemeralStorageMiB: 20480   # request == limit (Autopilot forces it)
```

Cluster-wide, set the default every run starts from (warren-4a95):

```
WARREN_K8S_EPHEMERAL_STORAGE_REQUEST_MIB=20480
WARREN_K8S_EPHEMERAL_STORAGE_LIMIT_MIB=20480
```

A per-project `resources` block beats the env default. The env default beats the compiled-in 10Gi.
Bounds are 64 MiB..1 TiB for both knobs (`src/warren-config/resources-config.ts`, `pickMiB` in `src/runtime/k8s/pod-spec.ts`) — an invalid env value falls back to the default.
When the block is absent, the `DEFAULT_K8S_EPHEMERAL_STORAGE_*_MIB` 10Gi default applies.
On Autopilot, the pod-level ephemeral-storage limit is the SUM of the container limits.
Both containers at 10Gi thus give a 20Gi pod budget, with the emptyDir capped at the per-container limit for a "workspace too big" signal.

### 7.4 Admission 429s

**Symptom.** Dispatch returns `429` with `Retry-After: 30` and a `reason`.

**Diagnose.** Read the `reason` (§5.5):

- `project_concurrency_exceeded` — one project saturated its own cap.
- `cluster_pending_saturated` — too many Pending pods cluster-wide.
- `queue_depth_exceeded` — total non-terminal pods hit the ceiling.

Cross-check `warren_run_admission_rejections_total{reason}` and the `warren_run_pod_phase{phase}` gauges.

**Remedy.** The 429s work as intended — a soft control sheds load before the cluster thrashes.
If the cap is genuinely too tight for your capacity, raise the matching knob (§3 env, or per-project `admission.maxConcurrentRuns`) and rollout-restart.
For `cluster_pending_saturated`, the real fix is more cluster capacity (§7.2), not a higher cap.
Clients must honor `Retry-After` and back off.

### 7.5 Repo-cache corruption

Applies only when the opt-in cache is enabled (§5.3). By default there is no cache: every run initialises with a blobless partial clone (warren-3b44) and no shared storage exists to corrupt.

**Symptom.** Init containers log clone or fetch failures against `/repo-cache`, and `warren_workspace_init_failures_total` rises.
Runs can still complete, only slower.

**Diagnose.** The cache is best-effort.
A corrupt bare mirror (`/repo-cache/<sha256(url)>.git`) makes the init container fall back to a direct network clone.
A wedged mirror thus **degrades latency, not correctness**.
Confirm via the init container log:

```bash
kubectl -n warren-runs logs run-<id> -c workspace-init
```

**Remedy.** Exec into a pod that mounts the PVC (or a debug pod) and delete the bad mirror directory — the next run re-mirrors it clean.
Or clear `WARREN_K8S_REPO_CACHE_PVC` to turn the cache off while you investigate (all runs then clone fresh).
Because RWO pins the cache to one node, corruption stays single-node-scoped.
The cache is only safe single-node — the RWO Multi-Attach deadlock is why it is opt-in (warren-554f).

### 7.6 Draining the control plane for maintenance

There is no in-flight-run migration — the control plane is a single replica, and SSE sessions are sticky.

To take the control plane down cleanly:

1. Pause dispatch — stop the scheduler (for example, set `WARREN_PLAN_RUN_DISABLED=1` and remove the cron triggers), or accept the bounded cron-retry backoff.
2. Let active run pods finish — watch `kubectl -n warren-runs get pods`.
3. Then `rollout restart`.

Run pods are independent of the control-plane pod.
They keep running across a control-plane restart, and reconcile via the pod-watcher when the control plane returns.
But a run that finalizes while the control plane is down will retry its callback, and can reap degraded.

### 7.7 Node failure (single-node clusters)

On a single-node cluster, or when a run pod's node dies, the pod vanishes from the API without a clean termination event.
The reduced **5-min watchdog** (not the legacy 45-min one) then marks the run `failed`.
It fires once the watch confirms that the pod is gone while the run row still says `running`.
The DB (Postgres, external) survives, and the control plane restarts via its Deployment.
Warren loses in-flight runs — it does not resume them.

### 7.8 Run stuck `running` after its pod completed (reap hang, warren-c433)

**Symptom.** A run row stays `state=running` with `endedAt=null` long after `kubectl -n warren-runs get pods` shows the pod as `Succeeded`/`Failed`.
The last log line is the run-state poller's terminal-observation message before stream teardown.

**Root cause (fixed).** The pod-log follow never hit EOF after the pod exited.
The post-terminal stream teardown parked on `iterator.return()` forever.
So reap — and the in-pod finalize handshake — never fired.

Mitigations now in place:

- A **5s bound** (`DEFAULT_STREAM_TEARDOWN_MS`) now caps the post-terminal stream teardown. A hung pod-log pump can no longer wedge the bridge's path to reap.
- The heartbeat watchdog gained a **terminal-reconcile net**. Each tick, the watchdog probes `status()` for a `running` run idle past `WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS` (default 2 min, `0` disables). If the pod is terminal-or-gone but the row still says `running`, the watchdog force-finalizes through reap with the pod's actual outcome. A `succeeded` pod re-drives the in-pod finalize. A still-polling pod parks and picks the intent up. An already-lapsed pod degrades to the documented finalize-timeout `FinalizeResult`. The net emits a `watchdog.terminal_reconciled` event on the run.

If a run still wedges:

- Check the control-plane logs for `watchdog reconciled terminal-but-stuck run`.
- If the net is off (`WARREN_RUN_TERMINAL_RECONCILE_GRACE_MS=0`), turn it back on.
- Or `kubectl -n warren-runs delete pod <pod>` to force the pod-gone path.

---

## 8. Capability degradations on k8s (know before you promise)

The K8sProvider does not match every LocalProvider capability.
The domain branches on `RuntimeCapabilities` (`src/runtime/contract.ts`).
Operators must know the gaps:

- **Preview environments are off** (`previewPorts: false`). A `.warren/preview.yaml` produces no preview and logs `reap.preview_skipped_unsupported`. Service/Ingress previews are a deferred feature.
- **Steering latency is ~5s, not real-time.** Steer writes a `run_inbox` row, and the in-pod agent polls `GET /runs/:id/inbox`. That trade gains reliability (it survives pod and control-plane restarts) at a latency cost against the LocalProvider stdin path.
- **Network policy is coarse.** No per-domain allowlist exists under k8s v1 (`networkPolicy: "coarse"`, against the LocalProvider's `domain-allowlist`). The base manifests ship default-deny ingress plus DNS/Service/open-external egress for `restricted` runs (§4.1). FQDN allowlisting is operator territory (Cilium / GKE Dataplane V2).
- **The repo cache is opt-in and RWO — single-node only.** The cache is off by default (warren-554f). If you enable it, move `warren-repo-cache` to a `ReadWriteMany` class (GKE Filestore CSI, or Longhorn on bare metal) **before** you add a second node. Otherwise concurrent run pods deadlock on the RWO claim (Multi-Attach, design R2). Do not provision Filestore only to run single-node. Leaving the cache off is the cheaper default.

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

# NetworkPolicy (run-pod egress contract, §4.1)
kubectl -n warren-runs get networkpolicy

# Edge (Cloud Armor, §1.7)
gcloud compute backend-services list --global --format='table(name,securityPolicy)'
gcloud compute security-policies rules list --security-policy=warren-armor
gcloud logging read 'jsonPayload.enforcedSecurityPolicy.outcome="DENY"' --limit=20

# Roll the control plane
kubectl -n warren rollout restart deploy/warren
```
