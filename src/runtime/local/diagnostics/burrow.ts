/**
 * Local-topology burrow access — the SINGLE allowlisted home for direct
 * `burrow-client` imports on the CLI + diagnostics surface (warren-11cc).
 *
 * Bucket 8 of the burrow-client eviction routed everything the
 * `RuntimeProvider` can serve (run dispatch via `provider.create`, sandbox
 * health via `provider.status`) through the seam. What is left is genuinely
 * local-topology-specific: probing the co-tenanted burrow daemon's unix socket
 * and constructing the local burrow client the `LocalProvider` runs against.
 * Neither has a provider-neutral home — they only exist because the LOCAL
 * backend co-tenants a burrow daemon — so they are scoped HERE, under
 * `src/runtime/local/`, out of `src/cli/` and `src/diagnostics/`, with this
 * doc comment stating why. Under `WARREN_RUNTIME=k8s` there is no burrow at all
 * (agents run in pods), so callers skip these probes entirely (mirroring the
 * `/readyz` behavior from warren-c128, `src/server/handlers/diagnostics.ts`).
 *
 * Covers: burrow socket reachability (single-client + local probe variants),
 * the `warren doctor` env-derived burrow check, and the `warren run`
 * local-backend resolver (burrow client + provider + capability-gated preview
 * seam).
 */

import { withTransportMapping } from "../../../burrow-client/client.ts";
import { BurrowClient, probeBurrowClient } from "../../../burrow-client/index.ts";
import { ValidationError } from "../../../core/errors.ts";
import type { DiagnosticCheck } from "../../../diagnostics/checks.ts";
import type { RuntimeProvider } from "../../contract.ts";
import { resolveRuntimeProvider } from "../../registry.ts";
import { createLocalSidecarsResolver, type LocalSidecarsResolver } from "../preview/sidecars.ts";

type EnvLike = Readonly<Record<string, string | undefined>>;

const BURROW_UNREACHABLE_HINT =
	"check that burrow serve is running and WARREN_BURROW_SOCKET / WARREN_BURROW_HOST point to it";

/**
 * Probe burrow's socket via `BurrowClient.probe()`. Wraps transport errors into
 * the same readable shape `withTransportMapping` produces for §4.3 spawn-flow
 * callers. Used by `warren doctor`, which probes a single env-derived client.
 */
export async function checkBurrowReachable(deps: {
	readonly burrowClient: BurrowClient;
}): Promise<DiagnosticCheck> {
	try {
		await withTransportMapping(deps.burrowClient.config, () => deps.burrowClient.probe());
		return { name: "burrow_reachable", ok: true };
	} catch (err) {
		return {
			name: "burrow_reachable",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: BURROW_UNREACHABLE_HINT,
		};
	}
}

/**
 * Probe the single local burrow for the server's /readyz handler (warren-76c5).
 * Multi-worker aggregation was retired with the K8s migration — the self-host
 * backend is one local burrow — so this is a single `/healthz` probe shaped as
 * the readyz check envelope.
 */
export async function checkBurrowPoolReachable(client: BurrowClient): Promise<DiagnosticCheck> {
	const result = await probeBurrowClient(client);
	if (result.ok) {
		return { name: "burrow_reachable", ok: true };
	}
	return {
		name: "burrow_reachable",
		ok: false,
		message: `${result.workerName}: ${result.error?.message ?? "unknown"}`,
		hint: BURROW_UNREACHABLE_HINT,
	};
}

/**
 * `warren doctor`'s burrow-socket check (moved out of `cli/commands/doctor.ts`,
 * warren-11cc). When `override` is supplied (tests) it drives that instead of
 * touching a socket; otherwise it builds a single env-derived `BurrowClient` and
 * probes it, mapping `ValidationError` config failures to a check failure with
 * the config's recovery hint.
 */
export async function doctorBurrowCheck(
	env: EnvLike,
	override?: (env: EnvLike) => Promise<void>,
): Promise<DiagnosticCheck> {
	if (override !== undefined) {
		try {
			await override(env);
			return { name: "burrow_reachable", ok: true };
		} catch (err) {
			return burrowFailure(err);
		}
	}
	let client: BurrowClient;
	try {
		client = BurrowClient.fromEnv(env);
	} catch (err) {
		return burrowFailure(err);
	}
	try {
		return await checkBurrowReachable({ burrowClient: client });
	} finally {
		await client.close().catch(() => undefined);
	}
}

function burrowFailure(err: unknown): DiagnosticCheck {
	if (err instanceof ValidationError) {
		return {
			name: "burrow_reachable",
			ok: false,
			message: err.message,
			...(err.recoveryHint !== undefined ? { hint: err.recoveryHint } : {}),
		};
	}
	return {
		name: "burrow_reachable",
		ok: false,
		message: err instanceof Error ? err.message : String(err),
		hint: BURROW_UNREACHABLE_HINT,
	};
}

/** The `warren run` local backend: a resolved provider plus its capability-gated seams. */
export interface LocalRunBackend {
	readonly runtimeProvider: RuntimeProvider;
	/** Preview sidecar resolver (present iff `capabilities.previewPorts`). */
	readonly previewSidecars?: LocalSidecarsResolver;
	/** Close any burrow client this backend lazily constructed. */
	close(): Promise<void>;
}

/**
 * Resolve the runtime backend for `warren run` (warren-11cc). Mirrors how
 * `bootServer` + `preview-gc-wiring.ts` wire the server: build the burrow client
 * lazily, thread `resolveRuntimeProvider` over it (honoring `WARREN_RUNTIME`),
 * and gate the preview sidecar seam on `capabilities.previewPorts`. Under
 * `WARREN_RUNTIME=k8s` the provider never calls the burrow factory and
 * `previewPorts` is `false`, so no burrow client is ever constructed and
 * `close()` is a no-op.
 */
export function resolveLocalRunBackend(env: EnvLike): LocalRunBackend {
	let client: BurrowClient | undefined;
	const getClient = (): BurrowClient => {
		if (client === undefined) client = BurrowClient.fromEnv(env);
		return client;
	};
	const runtimeProvider = resolveRuntimeProvider({ burrowClient: getClient }, env);
	const previewSidecars = runtimeProvider.capabilities.previewPorts
		? createLocalSidecarsResolver(getClient())
		: undefined;
	return {
		runtimeProvider,
		...(previewSidecars !== undefined ? { previewSidecars } : {}),
		close: async () => {
			if (client !== undefined) await client.close().catch(() => undefined);
		},
	};
}
