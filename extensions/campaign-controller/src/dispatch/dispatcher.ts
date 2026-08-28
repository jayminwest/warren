/**
 * Durable Warren dispatch and restart reconciliation (plan pl-91b6 step 7,
 * warren-2a0a).
 *
 * This module is the paid-work boundary of the controller. Its invariants:
 *
 * 1. **Intent before I/O.** Reserving the full per-run cap and persisting a
 *    deterministic `warren_dispatch` action with the exact request digest
 *    happen in ONE store transaction before any network request. A crash
 *    between that commit and the POST replans onto the same action key with
 *    the same idempotency key.
 * 2. **Stable idempotency key.** The action key IS the `Idempotency-Key`
 *    sent to warren, so a replayed delivery of the same attempt dedupes
 *    server-side for as long as warren's store remembers it.
 * 3. **Correlate confirmed runs, then read.** A confirmed POST persists the
 *    run id (`correlateRun`) before anything else; from then on the only
 *    warren interaction is the safe, retryable `GET /runs/:id` until the
 *    run reaches a terminal state.
 * 4. **Fail closed on ambiguity.** An ambiguous POST outcome with no known
 *    run settles the action `uncertain`, moves the work item to
 *    `dispatch_uncertain`, creates an attention item, and is NEVER retried
 *    — neither by this process nor after a restart — because warren's
 *    idempotency store is not durable across its own restarts.
 * 5. **Restart reconciles, never re-POSTs.** On boot: expire leases, resume
 *    known-run reads to terminal, and fail closed (uncertain + attention)
 *    for every unfinished action with no known run.
 * 6. **Conservative ledger.** The full cap stays reserved until the run is
 *    terminal with a KNOWN cost; an unknown terminal cost keeps the
 *    reservation active until an operator resolves it.
 *
 * Failure terminal records the structured outcome (state + failure reason)
 * on the action without advancing the work item.
 */

import type { IdGenerator } from "../clock.ts";
import { canonicalJson, sha256Hex } from "../digest.ts";
import { StateError } from "../errors.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import type { ActionRow, ReservationRow, WorkItemStatus } from "../store/types.ts";
import { TERMINAL_ACTION_STATES } from "../store/types.ts";
import {
	DispatchUncertainError,
	isTerminalRunState,
	runPushedBranch,
	WarrenAuthError,
	type WarrenClient,
	WarrenRateLimitError,
	WarrenRejectedError,
	type WarrenRunView,
} from "../warren-client.ts";

/** Action type persisted for every warren dispatch attempt. */
export const WARREN_DISPATCH_ACTION_TYPE = "warren_dispatch";

/** Attention reason recorded for a fail-closed ambiguous dispatch. */
export const DISPATCH_UNCERTAIN_REASON = "dispatch_uncertain";

/** The exact request the controller sends to warren (body fields only). */
export interface WarrenDispatchRequestSpec {
	readonly project: string;
	readonly agent: string;
	readonly prompt: string;
	readonly provider?: string;
	readonly model?: string;
	readonly maxCostUsd?: number;
	/** Dispatch onto this existing branch instead of a fresh workspace branch (warren-326f). */
	readonly existingBranch?: string;
}

export interface WarrenDispatcherDeps {
	readonly store: CampaignStateStore;
	readonly client: WarrenClient;
	readonly ids: IdGenerator;
	/** Lease TTL for the per-work-item dispatch claim. Default 60 000 ms. */
	readonly leaseTtlMs?: number;
}

/** Terminal status of one dispatch attempt. */
export type DispatchOutcomeStatus =
	/** POST confirmed; the run id is durably correlated. */
	| "dispatched"
	/** POST outcome unknown; failed closed, never retried. */
	| "dispatch_uncertain"
	/** Another tick holds the work item's dispatch lease. */
	| "excluded"
	/** Warren rejected the request before acceptance (429); retryable later. */
	| "retry_rejected"
	/** Warren rejected the request permanently; operator attention required. */
	| "needs_attention";

export interface DispatchOutcome {
	readonly status: DispatchOutcomeStatus;
	readonly actionId: string | null;
	readonly attempt: number | null;
	readonly runId: string | null;
	/** Run state at dispatch time, when a read already answered. */
	readonly runState: string | null;
	readonly errorClass: string | null;
	readonly retryAfterMs: number | null;
}

/** Result of reconciling one known run through authoritative GET reads. */
export interface RunReconcileResult {
	readonly runId: string;
	readonly runState: string;
	readonly terminal: boolean;
	/** True when THIS call settled action, work item, and ledger. */
	readonly settledNow: boolean;
	readonly workItemStatus: WorkItemStatus | null;
	readonly branch: string | null;
	/** Known terminal cost in cents, or null while unknown/conservative. */
	readonly costUsdCents: number | null;
}

export interface RestartFailClosedEntry {
	readonly actionId: string;
	readonly workItemId: string | null;
}

export interface RestartReconcileResult {
	readonly expiredLeases: number;
	readonly resumedRuns: ReadonlyArray<RunReconcileResult>;
	readonly failClosed: readonly RestartFailClosedEntry[];
}

function usdToCents(usd: number): number {
	return Math.round(usd * 100);
}

/** The exact body warren receives, built once so the digest is over truth. */
function dispatchBody(request: WarrenDispatchRequestSpec): Record<string, unknown> {
	return {
		agent: request.agent,
		project: request.project,
		prompt: request.prompt,
		...(request.provider !== undefined ? { providerOverride: request.provider } : {}),
		...(request.model !== undefined ? { modelOverride: request.model } : {}),
		...(request.maxCostUsd !== undefined ? { maxCostUsd: request.maxCostUsd } : {}),
		...(request.existingBranch !== undefined ? { existingBranch: request.existingBranch } : {}),
	};
}

export class WarrenDispatcher {
	readonly #store: CampaignStateStore;
	readonly #client: WarrenClient;
	readonly #holder: string;
	readonly #leaseTtlMs: number;

	constructor(deps: WarrenDispatcherDeps) {
		this.#store = deps.store;
		this.#client = deps.client;
		this.#holder = `dispatcher-${deps.ids.newId()}`;
		this.#leaseTtlMs = deps.leaseTtlMs ?? 60_000;
	}

	/**
	 * Dispatch one admitted work item to warren. The reservation, the
	 * `planned` action, and the exact request digest commit atomically
	 * BEFORE the POST. Returns the terminal outcome of the attempt; a
	 * `dispatch_uncertain` outcome is permanent for this work item.
	 */
	async dispatch(input: {
		campaignId: string;
		workItemId: string;
		request: WarrenDispatchRequestSpec;
		/** The reservation admission took, when admission reserved already. */
		reservationId?: string | null;
	}): Promise<DispatchOutcome> {
		const scope = `dispatch:${input.workItemId}`;
		// Claim the work item first: a concurrent tick holding the lease is
		// excluded before any state rule can misfire on in-flight transitions.
		const lease = this.#store.leases.acquireLease(scope, this.#holder, this.#leaseTtlMs);
		if (lease === null) {
			return {
				status: "excluded",
				actionId: null,
				attempt: null,
				runId: null,
				runState: null,
				errorClass: null,
				retryAfterMs: null,
			};
		}
		try {
			const workItem = this.#store.campaigns.getWorkItem(input.workItemId);
			if (workItem === null) {
				throw new StateError(`unknown work item: ${input.workItemId}`);
			}
			if (workItem.status !== "admitted") {
				throw new StateError(
					`work item ${input.workItemId} is ${workItem.status}; only admitted work can dispatch`,
				);
			}
			if (this.#hasUncertainAttempt(input.workItemId)) {
				// Never retry an ambiguous dispatch: a second POST could duplicate
				// paid work (plan risk 2, design record §9).
				throw new StateError(
					`work item ${input.workItemId} has an uncertain dispatch; it must never be re-dispatched`,
				);
			}
			return await this.#dispatchLocked(input);
		} finally {
			this.#store.leases.releaseLease(scope, this.#holder);
		}
	}

	/** The dispatch attempt, holding the per-work-item lease. */
	async #dispatchLocked(input: {
		campaignId: string;
		workItemId: string;
		request: WarrenDispatchRequestSpec;
		reservationId?: string | null;
	}): Promise<DispatchOutcome> {
		const campaign = this.#store.campaigns.getCampaign(input.campaignId);
		if (campaign === null) throw new StateError(`unknown campaign: ${input.campaignId}`);
		const requestDigest = sha256Hex(canonicalJson(dispatchBody(input.request)));

		// One transaction: reservation + intent, before any I/O.
		const attempt = this.#nextAttempt(input.workItemId);
		const actionKey = `warren-dispatch:${input.campaignId}:${input.workItemId}:a${attempt}`;
		const action = this.#store.transaction((): ActionRow => {
			const planned = this.#store.actions.beginAction({
				actionKey,
				campaignId: input.campaignId,
				workItemId: input.workItemId,
				actionType: WARREN_DISPATCH_ACTION_TYPE,
				requestDigest,
				policyDigest: campaign.policyDigest,
				attempt,
			});
			let reservation: ReservationRow | null = null;
			if (input.reservationId != null) {
				this.#store.budget.attachReservation(input.reservationId, planned.id);
			} else {
				reservation = this.#store.budget.reserve({
					campaignId: input.campaignId,
					actionId: planned.id,
					amountUsdCents: usdToCents(input.request.maxCostUsd ?? 0),
				});
			}
			if (reservation !== null && reservation.amountUsdCents <= 0) {
				throw new StateError(
					"dispatch without maxCostUsd cannot reserve the per-run cap; supply maxCostUsd or an admission reservation",
				);
			}
			this.#store.campaigns.setWorkItemStatus(input.workItemId, "dispatch_intent");
			return planned;
		});
		this.#store.actions.markExecuting(action.id);

		try {
			const run = await this.#client.dispatchRun({
				project: input.request.project,
				agent: input.request.agent,
				prompt: input.request.prompt,
				provider: input.request.provider,
				model: input.request.model,
				maxCostUsd: input.request.maxCostUsd,
				existingBranch: input.request.existingBranch,
				idempotencyKey: actionKey,
			});
			return this.#confirmRun(action, run);
		} catch (error) {
			return this.#settleDispatchFailure(action, error);
		}
	}

	/** Persist the confirmed run correlation, then read it once. */
	#confirmRun(action: ActionRow, run: WarrenRunView): DispatchOutcome {
		this.#store.transaction(() => {
			this.#store.events.correlateRun({
				runId: run.id,
				campaignId: action.campaignId,
				workItemId: action.workItemId,
				actionId: action.id,
			});
			this.#store.campaigns.setWorkItemStatus(action.workItemId as string, "dispatched");
		});
		// One authoritative read immediately: a fast fake or a terminal run
		// settles at once. A transient read failure leaves durable
		// correlation behind, so any later tick (or restart) resumes safely.
		try {
			const reconciled = this.#reconcileRunOf(action, run);
			return {
				status: "dispatched",
				actionId: action.id,
				attempt: action.attempt,
				runId: run.id,
				runState: reconciled.runState,
				errorClass: null,
				retryAfterMs: null,
			};
		} catch {
			return {
				status: "dispatched",
				actionId: action.id,
				attempt: action.attempt,
				runId: run.id,
				runState: null,
				errorClass: null,
				retryAfterMs: null,
			};
		}
	}

	/** Classify and durably settle a failed POST. */
	#settleDispatchFailure(action: ActionRow, error: unknown): DispatchOutcome {
		if (error instanceof DispatchUncertainError) {
			// Ambiguous: the run may exist. No known run id, so fail closed
			// forever — never a second POST, reservation stays conservative.
			this.#store.transaction(() => {
				this.#store.actions.settleAction(action.id, {
					state: "uncertain",
					errorClass: "ambiguous_response",
					errorJson: canonicalJson({
						message: error.message,
						note: "accepted-response-loss; warren idempotency is not durable across restart, so this attempt is never retried",
					}),
				});
				if (action.workItemId !== null) {
					this.#store.campaigns.setWorkItemStatus(action.workItemId, "dispatch_uncertain");
				}
				this.#store.events.addAttentionOnce({
					campaignId: action.campaignId,
					workItemId: action.workItemId,
					reason: DISPATCH_UNCERTAIN_REASON,
					detailJson: canonicalJson({
						key: `action:${action.id}`,
						actionId: action.id,
						actionKey: action.actionKey,
						idempotencyKey: action.actionKey,
					}),
				});
			});
			return {
				status: "dispatch_uncertain",
				actionId: action.id,
				attempt: action.attempt,
				runId: null,
				runState: null,
				errorClass: "ambiguous_response",
				retryAfterMs: null,
			};
		}
		if (error instanceof WarrenRateLimitError) {
			// Rejected before acceptance: unambiguous, no run exists.
			this.#store.transaction(() => {
				this.#store.actions.settleAction(action.id, {
					state: "retryable_failure",
					errorClass: "warren_rejected",
					errorJson: canonicalJson({ code: "rate_limited", retryAfterMs: error.retryAfterMs }),
				});
				this.#releaseReservation(action.id);
				if (action.workItemId !== null) {
					this.#store.campaigns.setWorkItemStatus(action.workItemId, "admitted");
				}
			});
			return {
				status: "retry_rejected",
				actionId: action.id,
				attempt: action.attempt,
				runId: null,
				runState: null,
				errorClass: "warren_rejected",
				retryAfterMs: error.retryAfterMs,
			};
		}
		if (error instanceof WarrenRejectedError || error instanceof WarrenAuthError) {
			this.#store.transaction(() => {
				this.#store.actions.settleAction(action.id, {
					state: "permanent_failure",
					errorClass: "warren_rejected",
					errorJson: canonicalJson({
						status: error instanceof WarrenRejectedError ? error.status : 401,
						warrenCode: error instanceof WarrenRejectedError ? error.warrenCode : "unauthorized",
						message: error.message,
					}),
				});
				this.#releaseReservation(action.id);
				if (action.workItemId !== null) {
					this.#store.campaigns.setWorkItemStatus(action.workItemId, "needs_attention");
				}
				this.#store.events.addAttentionOnce({
					campaignId: action.campaignId,
					workItemId: action.workItemId,
					reason: "dispatch_rejected",
					detailJson: canonicalJson({ key: `action:${action.id}`, actionId: action.id }),
				});
			});
			return {
				status: "needs_attention",
				actionId: action.id,
				attempt: action.attempt,
				runId: null,
				runState: null,
				errorClass: "warren_rejected",
				retryAfterMs: null,
			};
		}
		// Unexpected local error (validation, bug): fail closed the same way
		// as ambiguity — the request may already have left the process.
		this.#store.transaction(() => {
			this.#store.actions.settleAction(action.id, {
				state: "uncertain",
				errorClass: "unknown",
				errorJson: canonicalJson({ message: String(error) }),
			});
			if (action.workItemId !== null) {
				this.#store.campaigns.setWorkItemStatus(action.workItemId, "dispatch_uncertain");
			}
			this.#store.events.addAttentionOnce({
				campaignId: action.campaignId,
				workItemId: action.workItemId,
				reason: DISPATCH_UNCERTAIN_REASON,
				detailJson: canonicalJson({ key: `action:${action.id}`, actionId: action.id }),
			});
		});
		return {
			status: "dispatch_uncertain",
			actionId: action.id,
			attempt: action.attempt,
			runId: null,
			runState: null,
			errorClass: "unknown",
			retryAfterMs: null,
		};
	}

	/**
	 * Reconcile one known run through authoritative GET reads. Safe to call
	 * on every tick and after every restart: reads are idempotent, and
	 * settlement writes happen exactly once.
	 */
	async reconcileRun(runId: string): Promise<RunReconcileResult> {
		const link = this.#store.events.getRunLink(runId);
		if (link === null) throw new StateError(`no correlated run: ${runId}`);
		const run = await this.#client.getRun(runId);
		const action = link.actionId !== null ? this.#store.actions.getAction(link.actionId) : null;
		return this.#reconcileRunOf(action, run);
	}

	/** Shared read→settle path for freshly confirmed and known runs. */
	#reconcileRunOf(action: ActionRow | null, run: WarrenRunView): RunReconcileResult {
		const workItemId = action?.workItemId ?? this.#runLinkOfWorkItem(run.id);
		if (!isTerminalRunState(run.state)) {
			if (workItemId !== null) {
				this.#store.campaigns.setWorkItemStatus(workItemId, "running");
			}
			return {
				runId: run.id,
				runState: run.state,
				terminal: false,
				settledNow: false,
				workItemStatus: workItemId === null ? null : "running",
				branch: runPushedBranch(run),
				costUsdCents: null,
			};
		}
		if (action === null || TERMINAL_ACTION_STATES.includes(action.state)) {
			// Already settled (or foreign): report facts without rewriting.
			return {
				runId: run.id,
				runState: run.state,
				terminal: true,
				settledNow: false,
				workItemStatus: null,
				branch: runPushedBranch(run),
				costUsdCents: run.costUsd === null ? null : usdToCents(run.costUsd),
			};
		}
		const succeeded = run.state === "succeeded";
		this.#store.transaction(() => {
			this.#store.actions.settleAction(action.id, {
				state: succeeded ? "succeeded" : "permanent_failure",
				errorClass: succeeded ? null : "run_failed",
				errorJson: succeeded
					? null
					: canonicalJson({ runState: run.state, failureReason: run.failureReason }),
				resultRunId: run.id,
				resultBranch: runPushedBranch(run),
			});
			if (workItemId !== null) {
				this.#store.campaigns.setWorkItemStatus(workItemId, succeeded ? "terminal" : "failed");
			}
			// Conservative ledger: settle on the ACTUAL cost only when known;
			// an unknown cost keeps the full reservation active.
			const reservation = this.#store.budget.getReservationByAction(action.id);
			if (reservation !== null && reservation.state === "active" && run.costUsd !== null) {
				this.#store.budget.settleReservation(reservation.id, usdToCents(run.costUsd));
			}
		});
		return {
			runId: run.id,
			runState: run.state,
			terminal: true,
			settledNow: true,
			workItemStatus: succeeded ? "terminal" : "failed",
			branch: runPushedBranch(run),
			costUsdCents: run.costUsd === null ? null : usdToCents(run.costUsd),
		};
	}

	/**
	 * Boot-time reconciliation. Expires abandoned leases, resumes known-run
	 * reads to terminal, reconstructs the reservation picture (reservations
	 * are durable; settlement happens wherever a terminal cost is known),
	 * and fails closed every unfinished action with no correlated run. It
	 * never issues a POST.
	 */
	async reconcileAfterRestart(): Promise<RestartReconcileResult> {
		const expiredLeases = this.#store.leases.expireLeases();
		const resumedRuns: RunReconcileResult[] = [];
		const failClosed: RestartFailClosedEntry[] = [];
		for (const action of this.#store.actions.listUnfinishedActions()) {
			if (action.actionType !== WARREN_DISPATCH_ACTION_TYPE) continue;
			const link = this.#store.events.getRunLinkByAction(action.id);
			if (link !== null) {
				// Known run: resume authoritative reads.
				const run = await this.#client.getRun(link.runId);
				resumedRuns.push(this.#reconcileRunOf(action, run));
				continue;
			}
			// Unknown run: the POST may or may not have happened. Fail closed.
			this.#store.transaction(() => {
				this.#store.actions.settleAction(action.id, {
					state: "uncertain",
					errorClass: "ambiguous_response",
					errorJson: canonicalJson({
						reason: "restart_with_unconfirmed_dispatch",
						note: "controller restarted with a dispatch action that never correlated a run; the attempt is never retried",
					}),
				});
				if (action.workItemId !== null) {
					this.#store.campaigns.setWorkItemStatus(action.workItemId, "dispatch_uncertain");
				}
				this.#store.events.addAttentionOnce({
					campaignId: action.campaignId,
					workItemId: action.workItemId,
					reason: DISPATCH_UNCERTAIN_REASON,
					detailJson: canonicalJson({
						key: `action:${action.id}`,
						actionId: action.id,
						actionKey: action.actionKey,
						restart: true,
					}),
				});
			});
			failClosed.push({ actionId: action.id, workItemId: action.workItemId });
		}
		return { expiredLeases, resumedRuns, failClosed };
	}

	#runLinkOfWorkItem(runId: string): string | null {
		return this.#store.events.getRunLink(runId)?.workItemId ?? null;
	}

	#releaseReservation(actionId: string): void {
		const reservation = this.#store.budget.getReservationByAction(actionId);
		if (reservation !== null && reservation.state === "active") {
			this.#store.budget.releaseReservation(reservation.id);
		}
	}

	#nextAttempt(workItemId: string): number {
		return (
			this.#store.actions
				.listActionsForWorkItem(workItemId)
				.filter((action) => action.actionType === WARREN_DISPATCH_ACTION_TYPE).length + 1
		);
	}

	#hasUncertainAttempt(workItemId: string): boolean {
		return this.#store.actions
			.listActionsForWorkItem(workItemId)
			.some(
				(action) =>
					action.actionType === WARREN_DISPATCH_ACTION_TYPE && action.state === "uncertain",
			);
	}
}
