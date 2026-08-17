/**
 * `steerRun` — docs/http-api.md `POST /runs/:id/steer`.
 *
 * Forwards a steering message to the burrow inbox. Burrow's inbox is
 * scoped per-burrow (not per-run); the message is delivered to the next
 * agent turn on the same burrow. Warren's job is the warren-side lookup
 * (warren run id → burrow id) plus an audit event on the run's event log
 * so the live tail and the post-hoc UI show the operator's nudge in line
 * with everything else.
 *
 * Validation surface:
 *   - body must be non-empty (burrow rejects empty too, but failing fast
 *     keeps the wire calls clean).
 *   - run must not be in a terminal state — steering a finished run is
 *     meaningless. Returns `ValidationError`, not `StateTransitionError`,
 *     to match the error envelope (src/core/wire.ts) used by the rest of warren's HTTP
 *     surface for "operator asked for an impossible action".
 *   - run must have a `sandbox_id` attached. A queued warren row without a
 *     sandboxId is the spawn-rollback window; sending an inbox message in
 *     that window has nothing to attach to.
 *   - the run's harness must be able to consume the steer (warren-3305):
 *     `frontmatter.steering` "none" always rejects 409; "spawn-only"
 *     rejects a running run 409 (the harness only folds inbox messages into
 *     the prompt at spawn). Undeclared = legacy fail-open.
 *
 * The state of the run row is NOT modified here. Steering is purely an
 * out-of-band signal; the run's lifecycle continues to be observed via
 * the burrow stream + reap pipeline.
 *
 * Errors from burrow (`BurrowError` subclasses) and the transport layer
 * (`BurrowUnreachableError`) are passed through unchanged so the HTTP
 * route can map them onto the appropriate response envelope.
 */

import { StateTransitionError, ValidationError } from "../core/errors.ts";
import type { SteeringCapability } from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import { readSteeringCapability } from "../registry/steering.ts";
import type { Message, MessagePriority, RuntimeProvider } from "../runtime/contract.ts";
// The seam neutralizes burrow's `NotFoundError` into the provider-neutral
// `RuntimeRunNotFoundError` (warren-1f56), so steer catches THAT to map a ghost
// run onto a clean ValidationError — no `@os-eco/burrow-cli` import remains.
import { RuntimeRunNotFoundError } from "../runtime/errors.ts";
import type { RunEventBroker } from "./events.ts";

export interface SteerRunInput {
	readonly runId: string;
	readonly body: string;
	readonly priority?: MessagePriority;
	readonly fromActor?: string;
	readonly repos: Repos;
	/**
	 * Runtime-provider seam (K8s migration pl-829f step 13 / warren-1f56).
	 * The inbox send is `provider.sendMessage(handle, msg)`; the provider owns
	 * resolving its backend (the single-container LocalProvider resolves the sole
	 * burrow worker itself — placement/sticky-by-burrow is retired at the seam,
	 * design §3). Burrow-side errors (e.g. `NotFoundError` for a ghost burrow)
	 * propagate through the provider unchanged; steer maps them below exactly as
	 * it did against the raw client.
	 */
	readonly runtimeProvider: RuntimeProvider;
	/** If supplied, the audit event is published here too. */
	readonly broker?: RunEventBroker;
	readonly now?: () => Date;
}

export interface SteerRunResult {
	readonly message: Message;
}

export async function steerRun(input: SteerRunInput): Promise<SteerRunResult> {
	if (input.body.trim() === "") {
		throw new ValidationError("steer body cannot be empty");
	}

	const run = await input.repos.runs.require(input.runId);
	if (isTerminal(run.state)) {
		throw new ValidationError(`cannot steer a ${run.state} run`, {
			recoveryHint: "steering is only valid while the run is queued or running",
		});
	}
	assertHarnessCanSteer(run.agentName, steeringCapabilityOf(run.renderedAgentJson), run.state);
	if (run.sandboxId === null) {
		throw new ValidationError("run has no sandbox_id; cannot steer", {
			recoveryHint: "the burrow is provisioned during spawn — wait for spawn to complete",
		});
	}

	const sandboxId = run.sandboxId;
	// The seam `RunHandle`: `sandboxId` is the sandboxId the inbox is scoped to
	// (the only field `sendMessage` reads). `providerRunId` is carried for
	// completeness — burrow attributes delivery itself when a turn claims the
	// message, so a fresh send doesn't need it.
	const handle = { runId: run.id, sandboxId: sandboxId, providerRunId: run.sandboxRunId ?? "" };
	let message: Message;
	try {
		message = await input.runtimeProvider.sendMessage(handle, {
			body: input.body,
			...(input.priority !== undefined ? { priority: input.priority } : {}),
			...(input.fromActor !== undefined ? { fromActor: input.fromActor } : {}),
		});
	} catch (err) {
		if (err instanceof RuntimeRunNotFoundError) {
			// warren-b1a9: the backend has no record of this run (ghost). Steering
			// is meaningless against a lost run; reject with a clean
			// ValidationError so the UI knows to refresh — the bridge or the
			// next bootBridges pass will reconcile the warren row to `failed`.
			throw new ValidationError(
				`burrow '${sandboxId}' is unknown to the worker; the run is likely lost`,
				{ recoveryHint: "refresh — the bridge will reconcile this run to failed" },
			);
		}
		throw err;
	}

	await emitSteerEvent(input, run.id, message);
	return { message };
}

async function emitSteerEvent(
	input: SteerRunInput,
	runId: string,
	message: Message,
): Promise<void> {
	const now = input.now ?? (() => new Date());
	const seq = ((await input.repos.events.maxSeqForRun(runId)) ?? 0) + 1;
	const row = await input.repos.events.append({
		runId,
		sandboxEventSeq: seq,
		ts: now().toISOString(),
		kind: "steer.sent",
		stream: "system",
		payload: {
			messageId: message.id,
			priority: message.priority,
			fromActor: message.fromActor,
			body: input.body,
		},
	});
	input.broker?.publish(runId, row);
}

function isTerminal(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

/**
 * Extract the frozen agent frontmatter from `runs.rendered_agent_json` (same
 * defensive shape `resolveCostCapUsd` uses) and read its declared steering
 * capability. `undefined` = the agent predates the flag (warren-3305) and
 * stays legacy fail-open.
 */
function steeringCapabilityOf(renderedAgentJson: unknown): SteeringCapability | undefined {
	if (renderedAgentJson === null || typeof renderedAgentJson !== "object") return undefined;
	const frontmatter = (renderedAgentJson as Record<string, unknown>).frontmatter;
	if (frontmatter === null || typeof frontmatter !== "object") return undefined;
	return readSteeringCapability(frontmatter as Record<string, unknown>);
}

/**
 * warren-3305: fail loudly when the run's harness cannot consume the steer,
 * instead of recording `steer.sent` for a message nobody reads. 409
 * (`StateTransitionError`) because the conflict is between the request and
 * the run's current state/capability, not malformed input. An undeclared
 * capability is fail-open (pre-flag agents keep the historical behavior).
 *
 * `"spawn-only"` still allows steering a QUEUED run: the message waits in the
 * inbox and the runtime's `encodeInboxMessage` folds it into the prompt at
 * spawn. (The existing `sandbox_id` gate below may still reject a queued run
 * on the local topology — that error is already loud.)
 */
function assertHarnessCanSteer(
	agentName: string,
	capability: SteeringCapability | undefined,
	runState: string,
): void {
	if (capability === undefined || capability === "mid-run") return;
	if (capability === "none") {
		throw new StateTransitionError(`agent "${agentName}" cannot consume steering messages`, {
			recoveryHint:
				"this harness declares steering: none — re-dispatch with the corrected prompt instead",
		});
	}
	if (runState !== "queued") {
		throw new StateTransitionError(
			`agent "${agentName}" only consumes steering at spawn; this run is already ${runState}`,
			{
				recoveryHint:
					"the harness folds inbox messages into the prompt at spawn and never reads them mid-run — re-dispatch with the corrected prompt, or steer before the run leaves queued",
			},
		);
	}
}
