/**
 * Healer lifecycle extension (warren-4e74, pl-3a79 step 17) \u2014 the first
 * proof consumer of the Tier-1 observation event bus (warren-bb60).
 *
 * The closed-loop healer wakes a `healer` run when a production alert
 * (Sentry / Grafana) resolves to a warren-managed project
 * (`src/server/handlers/alerts.ts`). This module re-homes the healer's
 * run-lifecycle observability onto the bus's boot-time registration API
 * ({@link registerExtensions}) instead of any bespoke per-consumer
 * wiring: boot calls {@link createHealerLifecycleExtension} once and
 * registers it, and "removing the healer" is "don't register it" \u2014 not
 * surgery on the run loop.
 *
 * ## Observe-only (rule 6)
 *
 * The extension subscribes to `run_dispatched` and reacts ONLY to runs
 * carrying the `healer` trigger, emitting a structured `healer.dispatched`
 * observability line so an operator can see the closed loop fire without
 * tailing the alert intake. It mutates nothing, returns nothing the bus
 * reads, and cannot stall or veto a dispatch \u2014 exactly the Tier-1
 * contract. The durable `heal.dispatched` idempotency event stays where
 * it is (the intake handler, awaited before the 202) because the bus
 * holds nothing durable; this extension is the observe half only.
 */

import { type LifecycleExtension, WARREN_EXT_PROTOCOL } from "../runs/lifecycle-bus.ts";
import { HEALER_TRIGGER } from "./index.ts";

/** Minimal structured-logger surface the healer observer needs. */
export interface HealerObserverLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
}

export interface HealerLifecycleExtensionInput {
	readonly logger: HealerObserverLogger;
}

/**
 * Build the healer's observe-only lifecycle extension. Register it via
 * `registerExtensions(bus, [createHealerLifecycleExtension({ logger })])`
 * at boot. The handshake protocol is stamped so the bus rejects a
 * version mismatch (`warren-ext/v1`).
 */
export function createHealerLifecycleExtension(
	input: HealerLifecycleExtensionInput,
): LifecycleExtension {
	return {
		name: "healer",
		protocol: WARREN_EXT_PROTOCOL,
		hooks: {
			run_dispatched: (envelope) => {
				const { payload } = envelope;
				// Capability, not conditional (rule 7): this hook IS "observe a
				// healer dispatch", so it filters to the healer trigger and
				// ignores every other run.
				if (payload.trigger !== HEALER_TRIGGER) return;
				input.logger.info(
					{
						runId: payload.runId,
						projectId: payload.projectId,
						agentName: payload.agentName,
						branch: payload.branch,
						at: envelope.at,
					},
					"healer.dispatched",
				);
			},
		},
	};
}
