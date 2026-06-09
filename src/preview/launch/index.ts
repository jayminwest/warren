/**
 * `launchPreview` — spawn `preview.command` as a long-lived burrow sidecar
 * after a successful agent run, drive its readiness probe, and persist the
 * resulting `preview_state` (R-19 / SPEC §11.L, warren-f156). Split into
 * `launch/` modules in warren-62a7 / pl-9088 step 9.
 *
 * The actual orchestration (gating on outcome / opt-in / worker locality)
 * lives in `src/runs/reap/preview.ts`; this module owns the mechanics once those
 * gates pass:
 *
 *   1. **Allocate** a host port via `PreviewPortAllocator`. The allocator
 *      writes `preview_state='starting'` + `preview_port` atomically; if
 *      the range is exhausted, we surface that as a typed result and never
 *      touch burrow.
 *   2. **Spawn** the sidecar via `POST /burrows/:id/sidecars` with the
 *      configured `command` (run through `sh -c` so shell forms like
 *      `bun run dev` work without per-call argv-splitting) and the
 *      `inboundPortForward: { hostPort, sandboxPort: previewConfig.port }`
 *      so burrow opens the loopback bridge between the host port and the
 *      in-sandbox listener.
 *   3. **Probe** readiness from the warren-host side. Two phases:
 *      `tcpConnectOnce` (phase 1) waits for the port to bind, then
 *      `probeOnce` (phase 2) waits for a 2xx/3xx HTTP response. See
 *      `./probe.ts` for the per-phase contract.
 *   4. **Persist** the outcome via `RunsRepo.attachPreview`. `live`
 *      leaves `preview_port` set and clears `preview_failure_message`;
 *      `failed` populates `preview_failure_message` with the stderr tail
 *      and clears `preview_port` so the allocator can recycle the port.
 *      Failure cleanup also calls `sidecars.delete` best-effort so the
 *      process doesn't linger past the failure transition.
 *
 * Every observable side effect (port allocator, burrow client, readiness
 * fetch, clock, sleep) is injectable so unit tests don't touch real
 * sockets or wait on real timers.
 *
 * Result shape is a discriminated union — callers (reap) map each branch
 * onto a structured `reap_failed` event. Cancellation (manual teardown,
 * eviction worker) and TTLs are explicitly **out of scope here**; this
 * module only owns the starting → {live, failed} transition.
 *
 * Module layout (warren-62a7):
 *
 *   - `types.ts`       — `PreviewSidecarsClient`, `LaunchPreviewInput`,
 *                        `LaunchPreviewResult`, `LaunchFailureReason`,
 *                        tunable `DEFAULT_*` constants.
 *   - `probe.ts`       — health-check primitives: `tcpConnectOnce`
 *                        (phase-1, raw TCP) and `probeOnce` (phase-2,
 *                        HTTP).
 *   - `helpers.ts`     — shared helpers: `captureFailureTail`,
 *                        `safeDeleteSidecar`, `composeFailureMessage`,
 *                        `truncate`, `defaultSleep`, `defaultSidecarEnv`.
 *   - `setup.ts`       — `runSetupStep` for the optional setup pre-step
 *                        (warren-d9e7).
 *   - `orchestrate.ts` — `launchPreview` state machine.
 *   - `url.ts`         — `PreviewLaunchConfig`, `loadPreviewLaunchConfigFromEnv`,
 *                        `formatPreviewUrl` + the `WARREN_PREVIEW_*` env
 *                        constants.
 *
 * Public surface is re-exported here so existing call sites continue to
 * import from `../preview/launch.ts` (now `../preview/launch/index.ts`).
 */

export { launchPreview } from "./orchestrate.ts";
export { probeOnce, tcpConnectOnce } from "./probe.ts";
export {
	DEFAULT_CONNECT_TIMEOUT_MS,
	DEFAULT_READINESS_POLL_MS,
	DEFAULT_READINESS_TIMEOUT_MS,
	DEFAULT_SETUP_POLL_MS,
	DEFAULT_SETUP_TIMEOUT_MS,
	type LaunchFailureReason,
	type LaunchPreviewInput,
	type LaunchPreviewResult,
	PREVIEW_FAILURE_TAIL_BYTES,
	PROBE_PER_CALL_TIMEOUT_MS,
	type PreviewSidecarsClient,
} from "./types.ts";
export {
	formatPreviewUrl,
	loadPreviewLaunchConfigFromEnv,
	type PreviewLaunchConfig,
	type PreviewLaunchEnvLike,
	WARREN_PREVIEW_HOST_ENV,
	WARREN_PREVIEW_MODE_ENV,
} from "./url.ts";
