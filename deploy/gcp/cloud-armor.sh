#!/usr/bin/env bash
# Provision the Cloud Armor security policy the GKE Ingress enforces at the
# edge (warren-48d3). Idempotent — safe to re-run; existing rules are updated
# in place rather than duplicated.
#
# A Cloud Armor policy is a GCP *project* resource, not a Kubernetes object, so
# it cannot live in the kustomize tree. This script is its source of truth: the
# thresholds and rule set below are the reviewable artifact. The policy is
# bound to the LB backend by `deploy/k8s/overlays/gke/backendconfig.yaml`
# (`spec.securityPolicy.name`), which must name the same policy this script
# creates — `scripts/cloud-armor.test.ts` pins the two together.
#
# Usage:
#   deploy/gcp/cloud-armor.sh --dry-run                  # print the gcloud calls
#   deploy/gcp/cloud-armor.sh --project warren-502318    # apply
#   PROJECT_ID=warren-502318 deploy/gcp/cloud-armor.sh   # same, from env
#
# Thresholds (override via env; see docs/RUNBOOK-K8S.md §1.7):
#   WARREN_ARMOR_RATE_LIMIT_COUNT         requests per interval per client IP
#   WARREN_ARMOR_RATE_LIMIT_INTERVAL_SEC  the interval
#   WARREN_ARMOR_BAN_DURATION_SEC         how long an over-budget IP stays banned
#
# Requires: gcloud, authenticated with roles/compute.securityAdmin.
set -euo pipefail

# Must equal backendconfig.yaml `spec.securityPolicy.name`. Not env-overridable
# on purpose: renaming here without renaming there silently detaches the policy.
POLICY="warren-armor"

# 600 requests / 60s = 10 rps sustained per client IP. A first SPA load is
# ~10 requests and the UI then polls, so this is ~2 orders of magnitude above
# a real user while still capping a scripted flood. NAT'd offices share one
# key — raise the count rather than widening the interval if a shared egress
# IP gets banned (runbook §1.7).
RATE_LIMIT_COUNT="${WARREN_ARMOR_RATE_LIMIT_COUNT:-600}"
RATE_LIMIT_INTERVAL_SEC="${WARREN_ARMOR_RATE_LIMIT_INTERVAL_SEC:-60}"
BAN_DURATION_SEC="${WARREN_ARMOR_BAN_DURATION_SEC:-300}"

dry_run=false
project="${PROJECT_ID:-}"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run) dry_run=true; shift ;;
		--project) project="${2:?--project needs a GCP project id}"; shift 2 ;;
		-h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) echo "unknown arg: $1" >&2; exit 2 ;;
	esac
done

if [[ -z "${project}" ]]; then
	if [[ "${dry_run}" == false ]]; then
		echo "PROJECT_ID (or --project) is required; pass --dry-run to preview." >&2
		exit 2
	fi
	# Keep the flag array non-empty so `"${project_flags[@]}"` is safe under
	# `set -u` on bash 3.2 (macOS /bin/bash).
	project="PROJECT_ID"
fi
project_flags=(--project="${project}")

# Echo instead of executing under --dry-run so the rule set can be reviewed
# (and asserted on in tests) without touching a live project.
run() {
	if [[ "${dry_run}" == true ]]; then
		echo "+ $*"
		return 0
	fi
	"$@"
}

# --dry-run never probes GCP, so it always renders the `create` form.
exists() {
	[[ "${dry_run}" == false ]] && gcloud compute security-policies "$@" \
		"${project_flags[@]}" >/dev/null 2>&1
}

ensure_policy() {
	if exists describe "${POLICY}"; then
		echo "policy ${POLICY} exists"
	else
		run gcloud compute security-policies create "${POLICY}" \
			--description="warren control-plane edge protection (deploy/gcp/cloud-armor.sh)" \
			"${project_flags[@]}"
	fi
}

# rule <priority> <flags...> — create it, or update it in place if present.
rule() {
	local priority="$1"; shift
	local verb=create
	if exists rules describe "${priority}" --security-policy="${POLICY}"; then
		verb=update
	fi
	run gcloud compute security-policies rules "${verb}" "${priority}" \
		--security-policy="${POLICY}" "$@" "${project_flags[@]}"
}

ensure_policy

# --- 1000: per-IP rate limiting -------------------------------------------
# `rate-based-ban` (not plain `throttle`) so a flooding IP is dropped for
# BAN_DURATION_SEC instead of being re-evaluated request by request — the
# single-replica control plane should not pay for the excess at all.
#
# `--enforce-on-key=IP` is correct only while DNS is unproxied. Cloudflare must
# stay grey-cloud for ManagedCertificate validation (managedcertificate.yaml),
# so the connecting IP *is* the client. If a proxy is ever put in front,
# switch to `--enforce-on-key=XFF-IP` or every request keys off the proxy.
#
# Rate limiting counts *requests*, not bytes or seconds, so a long-lived
# NDJSON stream on GET /runs/:id/events costs one request at open and is never
# torn down by this rule (runbook §1.7).
rule 1000 \
	--description="per-IP rate limit: ${RATE_LIMIT_COUNT} req / ${RATE_LIMIT_INTERVAL_SEC}s, ban ${BAN_DURATION_SEC}s" \
	--src-ip-ranges="*" \
	--action=rate-based-ban \
	--rate-limit-threshold-count="${RATE_LIMIT_COUNT}" \
	--rate-limit-threshold-interval-sec="${RATE_LIMIT_INTERVAL_SEC}" \
	--ban-duration-sec="${BAN_DURATION_SEC}" \
	--conform-action=allow \
	--exceed-action=deny-429 \
	--enforce-on-key=IP

# --- 2000s: enforced preconfigured WAF ------------------------------------
# Only signatures that cannot match legitimate warren traffic are enforced.
# Warren's request bodies are agent prompts and rendered agent JSON — arbitrary
# prose, shell, SQL and HTML by design — so the injection rule sets belong in
# preview (below), never in an enforcing rule. These two match the HTTP framing
# and the caller, not the payload, at the lowest sensitivity.
rule 2000 \
	--description="protocol attacks (request smuggling / header injection)" \
	--expression="evaluatePreconfiguredWaf('protocolattack-v33-stable', {'sensitivity': 1})" \
	--action=deny-403

rule 2100 \
	--description="known vulnerability scanners" \
	--expression="evaluatePreconfiguredWaf('scannerdetection-v33-stable', {'sensitivity': 1})" \
	--action=deny-403

# --- 9000s: preview-only payload signatures -------------------------------
# `--preview` logs matches without blocking. These exist for forensics after an
# incident, and to measure the false-positive rate against real prompt traffic
# before anyone considers enforcing them. Do NOT drop --preview: a prompt that
# says "drop table users" is a legitimate request to warren.
rule 9000 \
	--description="PREVIEW ONLY — SQLi signatures false-positive on agent prompts" \
	--expression="evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})" \
	--action=deny-403 \
	--preview

rule 9100 \
	--description="PREVIEW ONLY — XSS signatures false-positive on agent prompts" \
	--expression="evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})" \
	--action=deny-403 \
	--preview

rule 9200 \
	--description="PREVIEW ONLY — RCE signatures match every shell command in a prompt" \
	--expression="evaluatePreconfiguredWaf('rce-v33-stable', {'sensitivity': 1})" \
	--action=deny-403 \
	--preview

rule 9300 \
	--description="PREVIEW ONLY — LFI signatures match every file path in a prompt" \
	--expression="evaluatePreconfiguredWaf('lfi-v33-stable', {'sensitivity': 1})" \
	--action=deny-403 \
	--preview

cat <<MSG

Policy ${POLICY} reconciled. It takes effect once the LB backend references it:
  deploy/k8s/overlays/gke/backendconfig.yaml  (spec.securityPolicy.name)
  kubectl apply -k deploy/k8s/overlays/gke-live

Verify the attachment and watch decisions:
  gcloud compute backend-services list --global --format='table(name,securityPolicy)'
  gcloud logging read 'jsonPayload.enforcedSecurityPolicy.name="${POLICY}"' --limit=20

Kill switch and threshold tuning: docs/RUNBOOK-K8S.md §1.7.
MSG
