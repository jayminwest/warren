/**
 * `LocalProvider` — the burrow-backed `RuntimeProvider` (contract in
 * `../contract.ts`). It is the self-host / single-container backend: it wraps
 * warren's existing `src/burrow-client/` facade so today's behavior flows
 * through the seam unchanged (design doc §7, plan §6 checkpoint 2).
 *
 * This step (pl-829f step 7, phase CONTRACT) lands the SHELL only: the
 * capability set is real and final, but every method body is a deliberate stub
 * that throws `RuntimeNotImplementedError`. Later steps of the LocalProvider
 * checkpoint replace each stub with a burrow-client-backed implementation; the
 * constructor already accepts the dependency they will wrap.
 *
 * The dependency is taken as a FACTORY (`() => BurrowClientPool`) rather than a
 * live pool: at boot the pool already exists so wiring is `() => pool`, but the
 * lazy shape keeps the stubs — and the registry that builds this — testable
 * without standing up a pool (which needs a DB + burrow socket). None of the
 * stubs invoke the factory, so tests never construct one.
 */

import type { BurrowClientPool } from "../../burrow-client/index.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	Message,
	NormalizedEvent,
	OutboundMessage,
	RunHandle,
	RunSpec,
	RunStatus,
	RuntimeCapabilities,
	RuntimeProvider,
	StreamOpts,
	TeardownResult,
} from "../contract.ts";
import { RuntimeNotImplementedError } from "../errors.ts";

/** Dependencies the burrow-backed provider methods will wrap in later steps. */
export interface LocalProviderDeps {
	/**
	 * Lazily supplies the burrow-client pool the real methods adapt (placement
	 * happens per-run inside the pool). A factory so the provider can be built
	 * before — or without — a live pool; see the file header.
	 */
	readonly burrowClientPool: () => BurrowClientPool;
}

/**
 * The burrow feature set. LocalProvider is the reference backend, so every
 * capability is at its strongest: all booleans `true` and the per-domain
 * network allowlist (design doc §5 — the K8s v1 backend degrades several of
 * these, e.g. `networkPolicy: "coarse"`). Frozen so the domain can read but
 * never mutate a provider's advertised capabilities.
 */
export const LOCAL_PROVIDER_CAPABILITIES: RuntimeCapabilities = Object.freeze({
	previewPorts: true,
	networkPolicy: "domain-allowlist",
	longLived: true,
	midRunSteering: true,
	enforcedResourceLimits: true,
	workspaceArchive: true,
});

/** Raise the standard stub error, naming the method and the step that fills it. */
function notImplemented(method: string): never {
	throw new RuntimeNotImplementedError(`LocalProvider.${method}() is not implemented yet`, {
		recoveryHint:
			"Filled in a later step of the LocalProvider checkpoint (pl-829f, phase CONTRACT) — " +
			"the method wraps src/burrow-client/. This shell only fixes the contract shape.",
	});
}

export class LocalProvider implements RuntimeProvider {
	readonly capabilities: RuntimeCapabilities = LOCAL_PROVIDER_CAPABILITIES;

	constructor(private readonly deps: LocalProviderDeps) {
		// `deps` is intentionally retained but unused until the method bodies land.
		void this.deps;
	}

	create(_spec: RunSpec): Promise<RunHandle> {
		return notImplemented("create");
	}

	streamEvents(_handle: RunHandle, _opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		return notImplemented("streamEvents");
	}

	status(_handle: RunHandle): Promise<RunStatus> {
		return notImplemented("status");
	}

	sendMessage(_handle: RunHandle, _msg: OutboundMessage): Promise<Message> {
		return notImplemented("sendMessage");
	}

	cancel(_handle: RunHandle, _reason?: string): Promise<void> {
		return notImplemented("cancel");
	}

	finalize(_handle: RunHandle, _intent: FinalizeIntent): Promise<FinalizeResult> {
		return notImplemented("finalize");
	}

	terminate(_handle: RunHandle): Promise<TeardownResult> {
		return notImplemented("terminate");
	}
}
