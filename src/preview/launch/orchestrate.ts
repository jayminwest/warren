/**
 * `launchPreview` — main entry point for the preview launch state machine
 * (warren-f156, split into `launch/` modules in warren-62a7 / pl-9088 step 9).
 *
 * Flow: port allocation → optional setup pre-step → spawn dev-server
 * sidecar → two-phase readiness probe (TCP connect, then HTTP) → persist
 * `preview_state` via `RunsRepo.attachPreview`. See `./index.ts` for the
 * module-level walkthrough and contract.
 */

import { PORT_EXHAUSTED_REASON } from "../port-allocator.ts";
import {
	captureFailureTail,
	composeFailureMessage,
	defaultSidecarEnv,
	defaultSleep,
	headTruncate,
	safeDeleteSidecar,
} from "./helpers.ts";
import { probeOnce, tcpConnectOnce } from "./probe.ts";
import { runSetupStep } from "./setup.ts";
import {
	DEFAULT_CONNECT_TIMEOUT_MS,
	DEFAULT_READINESS_POLL_MS,
	DEFAULT_READINESS_TIMEOUT_MS,
	DEFAULT_SETUP_POLL_MS,
	DEFAULT_SETUP_TIMEOUT_MS,
	type LaunchPreviewInput,
	type LaunchPreviewResult,
	PREVIEW_FAILURE_TAIL_BYTES,
	PROBE_PER_CALL_TIMEOUT_MS,
} from "./types.ts";

export async function launchPreview(input: LaunchPreviewInput): Promise<LaunchPreviewResult> {
	const now = input.now ?? (() => new Date());
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const tcpConnectImpl = input.tcpConnect ?? tcpConnectOnce;
	const sleep = input.sleep ?? defaultSleep;
	const timeoutMs = input.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const pollMs = input.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
	const perCallTimeoutMs = input.probePerCallTimeoutMs ?? PROBE_PER_CALL_TIMEOUT_MS;
	const setupTimeoutMs = input.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
	const setupPollMs = input.setupPollMs ?? DEFAULT_SETUP_POLL_MS;

	const allocation = await input.allocator.allocate(input.runId, now());
	if (allocation.status === "exhausted") {
		const message = `preview port range exhausted (reason=${PORT_EXHAUSTED_REASON})`;
		await input.repos.runs.attachPreview(input.runId, {
			previewState: "failed",
			previewFailureMessage: message,
		});
		return { ok: false, reason: "port_exhausted", message, failureTail: "", port: null };
	}
	const port = allocation.port;

	// warren-d9e7: setup pre-step. Runs to completion (no inbound forward) so
	// dependency install fails fast and surfaces a distinct failure reason
	// instead of degrading into readiness_timeout. Skipped when no setup
	// command is configured — existing single-command projects keep working.
	if (input.previewConfig.setup !== undefined) {
		const setupResult = await runSetupStep({
			input,
			now,
			sleep,
			setupCommand: input.previewConfig.setup,
			setupTimeoutMs,
			setupPollMs,
		});
		if (!setupResult.ok) {
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "failed",
				previewPort: null,
				previewFailureMessage: composeFailureMessage(setupResult.message, setupResult.failureTail),
			});
			return { ...setupResult, port };
		}
	}

	let sidecarId: string;
	try {
		const created = await input.sidecars.create({
			burrowId: input.burrowId,
			command: ["sh", "-c", input.previewConfig.command],
			env: defaultSidecarEnv(input.previewConfig.port),
			inboundPortForward: { hostPort: port, sandboxPort: input.previewConfig.port },
			...(input.previewConfig.readiness_path !== undefined
				? { readinessPath: input.previewConfig.readiness_path }
				: {}),
		});
		sidecarId = created.id;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await input.repos.runs.attachPreview(input.runId, {
			previewState: "failed",
			previewPort: null,
			previewFailureMessage: `sidecar create failed: ${headTruncate(message, PREVIEW_FAILURE_TAIL_BYTES)}`,
		});
		return {
			ok: false,
			reason: "create_failed",
			message,
			failureTail: "",
			port,
		};
	}

	const readinessPath = input.previewConfig.readiness_path ?? "/";
	const probeUrl = `http://127.0.0.1:${port}${readinessPath}`;

	// warren-9b15: two-phase probe loop. Phase 1 ("connect") waits for the
	// sidecar's listener to accept TCP — a raw TCP handshake proves the
	// port is bound (see warren-44ed for why phase 1 doesn't speak HTTP).
	// Phase 2 ("readiness") then waits for 2xx/3xx with its own wall clock,
	// starting at the phase transition. Splitting the budget means a slow
	// burrow / cold image / shell pre-exec hang surfaces as `connect_timeout`
	// and stops eating the bundler budget.
	// warren-44ed / pl-592f step 2: phase-1 uses tcpConnectOnce (raw TCP
	// handshake) instead of probeOnce (HTTP fetch) so slow-first-headers
	// dev servers (e.g. Next.js mid-compile) don't get misclassified as
	// not_connected while their port is actually bound. probeOnce stays
	// in phase 2 where the HTTP-level readiness question is the right one.
	const connectDeadline = now().getTime() + connectTimeoutMs;
	while (true) {
		const probe = await tcpConnectImpl("127.0.0.1", port, perCallTimeoutMs);
		if (probe === "connected") {
			// Phase 1 → phase 2: port accepts TCP. HTTP readiness is phase-2's job.
			break;
		}
		// probe === "not_connected" → keep waiting under the connect budget.
		if (now().getTime() >= connectDeadline) {
			const failureTail = await captureFailureTail(input.sidecars, input.burrowId, sidecarId);
			await safeDeleteSidecar(input.sidecars, input.burrowId, sidecarId);
			const message = `phase=connect: preview port did not accept a TCP connection within ${connectTimeoutMs}ms (probed ${probeUrl})`;
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "failed",
				previewPort: null,
				previewFailureMessage: composeFailureMessage(message, failureTail),
			});
			return {
				ok: false,
				reason: "connect_timeout",
				message,
				failureTail,
				port,
			};
		}
		await sleep(pollMs);
	}

	const readinessDeadline = now().getTime() + timeoutMs;
	while (true) {
		const probe = await probeOnce(fetchImpl, probeUrl, perCallTimeoutMs);
		if (probe === "ready") {
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "live",
				previewLastHitAt: now().toISOString(),
				previewFailureMessage: null,
			});
			return { ok: true, port, sidecarId };
		}
		// In phase 2 both "http_response" and "not_connected" mean "not ready
		// yet" — the latter can legitimately happen if the dev server briefly
		// disconnects mid-restart (e.g. HMR rebuilds). We keep probing under
		// the readiness budget either way.
		if (now().getTime() >= readinessDeadline) {
			const failureTail = await captureFailureTail(input.sidecars, input.burrowId, sidecarId);
			await safeDeleteSidecar(input.sidecars, input.burrowId, sidecarId);
			const message = `phase=readiness: readiness probe did not return 2xx within ${timeoutMs}ms (probed ${probeUrl})`;
			await input.repos.runs.attachPreview(input.runId, {
				previewState: "failed",
				previewPort: null,
				previewFailureMessage: composeFailureMessage(message, failureTail),
			});
			return {
				ok: false,
				reason: "readiness_timeout",
				message,
				failureTail,
				port,
			};
		}
		await sleep(pollMs);
	}
}
