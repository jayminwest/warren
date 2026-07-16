/**
 * K8s per-run pod resource + network defaults for `.warren/config.yaml`
 * (warren-ac7a / pl-829f step 14, design k8s-migration.md §3.1).
 *
 * Extracted from `schema.ts` (same idiom as `feature-loop-config.ts`) so the
 * core schema file stays under the file-size budget; `schema.ts` re-exports
 * `ResourcesConfigSchema` / `ResourcesConfig` and folds the block into
 * `DefaultsConfigSchema`.
 *
 * Under pod-per-run the `RunSpec`'s `resources`/`network` intent maps to a K8s
 * pod `resources.requests/limits` + a coarse network policy; this block is where
 * a project pins those defaults, consumed by the K8sProvider's pod-spec builder
 * (`src/runtime/k8s/pod-spec.ts`). Nested into ONE `resources` block (not
 * scattered fields) per plan §7 Q-config-schema — the `.strict()`
 * `DefaultsConfigSchema` tolerates exactly one new key. Values mirror the
 * design-doc per-run defaults: requests govern scheduling (1 CPU / 2 GiB),
 * limits are the kubelet-enforced hard caps (4 CPU / 4 GiB). Absent block → the
 * builder falls back to the `DEFAULT_K8S_*` constants, same posture as
 * `agent.pauseTimeoutMs`.
 */

import { z } from "zod";

// RunSpec's provider-neutral network intent verbatim (contract.ts `RunSpec.network`).
export const NetworkPolicySchema = z.enum(["none", "restricted", "open"]);
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export const DEFAULT_K8S_MEMORY_REQUEST_MIB = 2048; // 2 GiB
export const DEFAULT_K8S_MEMORY_LIMIT_MIB = 4096; // 4 GiB
export const DEFAULT_K8S_CPU_REQUEST_MILLICORES = 1000; // 1 CPU
export const DEFAULT_K8S_CPU_LIMIT_MILLICORES = 4000; // 4 CPU
// Ephemeral-storage (warren-653f): the emptyDir workspace (`git clone` + `bun
// install`) counts against the pod's ephemeral-storage limit. When UNSET, GKE
// Autopilot injects a 1Gi default that a real clone+install blows past in ~7
// min, evicting the pod. Set an explicit, generous 10 GiB on both the agent and
// the workspace-init containers so a normal run never trips the kubelet's
// ephemeral-storage eviction. Request == limit (Autopilot forces it anyway).
export const DEFAULT_K8S_EPHEMERAL_STORAGE_REQUEST_MIB = 10_240; // 10 GiB
export const DEFAULT_K8S_EPHEMERAL_STORAGE_LIMIT_MIB = 10_240; // 10 GiB
export const DEFAULT_K8S_NETWORK: NetworkPolicy = "restricted";

// Bounds: 64 MiB..128 GiB rules out a typo'd sub-container floor or an
// implausible request no node could schedule; 10m..64 cores likewise. Integers
// only — MiB and millicores are the whole-number units the pod-spec builder
// renders to K8s quantity strings (`<n>Mi`, `<n>m`).
const MemoryMiBSchema = z
	.number()
	.int("memoryMiB must be an integer (mebibytes)")
	.min(64, "memoryMiB must be between 64 (64 MiB) and 131072 (128 GiB)")
	.max(131_072, "memoryMiB must be between 64 (64 MiB) and 131072 (128 GiB)");

const CpuMillicoresSchema = z
	.number()
	.int("cpuMillicores must be an integer (millicores)")
	.min(10, "cpuMillicores must be between 10 (10m) and 64000 (64 cores)")
	.max(64_000, "cpuMillicores must be between 10 (10m) and 64000 (64 cores)");

// Ephemeral-storage in MiB (whole mebibytes, same unit as memory). Bounds:
// 64 MiB..1 TiB rules out a typo'd sub-container floor or an implausible disk
// no node could schedule. The pod-spec builder renders it to a `<n>Mi` K8s
// quantity string, same as memory (warren-653f).
const EphemeralStorageMiBSchema = z
	.number()
	.int("ephemeralStorageMiB must be an integer (mebibytes)")
	.min(64, "ephemeralStorageMiB must be between 64 (64 MiB) and 1048576 (1 TiB)")
	.max(1_048_576, "ephemeralStorageMiB must be between 64 (64 MiB) and 1048576 (1 TiB)");

// Every field is optional so a project can pin just one knob (e.g. only bump
// the memory limit) and leave the rest to the DEFAULT_K8S_* fallback the
// K8sProvider's `resolveK8sPodConfig` applies. Bounds still validate any value
// that IS supplied. Keeping the defaulting in one place (the resolver, not the
// schema) sidesteps zod v4's output-typed `.default({})` and matches how the
// resolver already merges env + config.
const ResourceQuantitiesSchema = z
	.object({
		memoryMiB: MemoryMiBSchema.optional(),
		cpuMillicores: CpuMillicoresSchema.optional(),
		ephemeralStorageMiB: EphemeralStorageMiBSchema.optional(),
	})
	.strict();

export const ResourcesConfigSchema = z
	.object({
		requests: ResourceQuantitiesSchema.optional(),
		limits: ResourceQuantitiesSchema.optional(),
		network: NetworkPolicySchema.optional(),
	})
	.strict();

export type ResourcesConfig = z.infer<typeof ResourcesConfigSchema>;

// warren-b6f2 / pl-829f step 21: per-project admission control (design §3.3).
// `maxConcurrentRuns` caps this project's simultaneous non-terminal runs on the
// K8s backend — the provider enforces it as a soft admission gate (429 on
// exceed), stopping one busy project from starving others. Absent block ⇒ the
// global default `WARREN_K8S_MAX_PROJECT_CONCURRENCY`, else unlimited. Ignored
// by LocalProvider. Housed here (not `schema.ts`) for the file-size budget.
export const AdmissionConfigSchema = z
	.object({
		maxConcurrentRuns: z
			.number()
			.int("admission.maxConcurrentRuns must be a positive integer")
			.positive("admission.maxConcurrentRuns must be a positive integer")
			.optional(),
	})
	.strict();

export type AdmissionConfig = z.infer<typeof AdmissionConfigSchema>;
