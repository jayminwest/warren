#!/usr/bin/env bash
# Build (and optionally load) the three warren container images the K8s
# manifests reference (warren-186c). Run from anywhere — paths resolve against
# the repo root.
#
#   warren:latest                  — control-plane (root Dockerfile)
#   warren-agent:latest            — in-pod agent toolchain (Dockerfile.agent)
#   warren-workspace-init:latest   — init container (Dockerfile.workspace-init)
#
# Usage:
#   deploy/docker/build-images.sh                # build all three
#   deploy/docker/build-images.sh --load-k3d <cluster>   # + k3d image import
#   deploy/docker/build-images.sh --load-kind <cluster>  # + kind load
#   deploy/docker/build-images.sh --only agent           # build one image
#   TAG=v1.2.3 deploy/docker/build-images.sh             # override the tag
#
# The K8s overlays pin `imagePullPolicy: Never` for local (kind/k3d), so the
# node must already hold the image — hence the load step. Push to a registry
# for GKE (see deploy/k8s/README.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAG="${TAG:-latest}"

CONTROL_IMAGE="warren:${TAG}"
AGENT_IMAGE="warren-agent:${TAG}"
INIT_IMAGE="warren-workspace-init:${TAG}"

load_mode=""
load_cluster=""
only=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--load-k3d) load_mode="k3d"; load_cluster="${2:?--load-k3d needs a cluster name}"; shift 2 ;;
		--load-kind) load_mode="kind"; load_cluster="${2:?--load-kind needs a cluster name}"; shift 2 ;;
		--only) only="${2:?--only needs an image: control|agent|init}"; shift 2 ;;
		-h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) echo "unknown arg: $1" >&2; exit 2 ;;
	esac
done

build() {
	local image="$1" dockerfile="$2"
	echo "==> building ${image} (${dockerfile})"
	docker build -f "${REPO_ROOT}/${dockerfile}" -t "${image}" "${REPO_ROOT}"
}

want() { [[ -z "${only}" || "${only}" == "$1" ]]; }

want control && build "${CONTROL_IMAGE}" "Dockerfile"
want agent && build "${AGENT_IMAGE}" "deploy/docker/Dockerfile.agent"
want init && build "${INIT_IMAGE}" "deploy/docker/Dockerfile.workspace-init"

if [[ -n "${load_mode}" ]]; then
	images=()
	want control && images+=("${CONTROL_IMAGE}")
	want agent && images+=("${AGENT_IMAGE}")
	want init && images+=("${INIT_IMAGE}")
	for image in "${images[@]}"; do
		echo "==> loading ${image} into ${load_mode} cluster '${load_cluster}'"
		if [[ "${load_mode}" == "k3d" ]]; then
			k3d image import "${image}" --cluster "${load_cluster}"
		else
			kind load docker-image "${image}" --name "${load_cluster}"
		fi
	done
fi

echo "==> done"
