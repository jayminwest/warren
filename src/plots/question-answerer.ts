/**
 * `PlotQuestionAnswerer` — Plot question-answer seam for
 * `POST /plots/:id/questions/:event_id/answer` (warren-e1ac /
 * pl-9d6a step 12).
 *
 * Mirrors the `PlotIntentEditor` / `PlotStatusChanger` / `PlotAttacher`
 * shape (one-method interface + `defaultPlotQuestionAnswerer` production
 * impl + `ServerDeps.plotQuestionAnswerer` test seam) so the handler
 * can stay disk-free in unit tests.
 *
 * The handler-edge concurrency invariant (seed body) is:
 *
 *   (a) the targeted `:event_id` corresponds to a `question_posed` event
 *       in the Plot's event log, AND
 *   (b) no subsequent `question_answered` event references it
 *       (`data.question_id === :event_id`).
 *
 * The `@os-eco/plot-cli` library guarantees neither half — it doesn't
 * gate `question_answered` appends on the absence of a prior answer or
 * on the existence of a posing question. Warren owns the invariant.
 *
 * The wire `:event_id` is the `at` ISO timestamp of the `question_posed`
 * event. PlotEvent has no synthetic id field; `at` is the only stable
 * identifier the lib surfaces. The UI reads the event log via
 * `GET /plots/:id` and feeds `event.at` back as `:event_id`.
 *
 * Unlike `defaultPlanRunPlotAppender` this surface is NOT fire-and-log:
 * the user is waiting on the result of an answer submit, so failure
 * must surface synchronously as the HTTP response.
 *
 * The compile-time ACL guard on `UserPlotClient` (mx-bd4d67) makes the
 * agent-actor mistake unreachable from this code path. Per SPEC §6,
 * `question_answered` is one of the four humans-only event types — the
 * `AgentPlotHandle.append` generic parameter excludes it at compile
 * time, and the runtime guard in `handle.ts` rejects it as defense in
 * depth. Threading the actor kind via the typed client class here keeps
 * the wire log consistent with the intent/status/attach writes.
 */

import type { PlotEvent } from "@os-eco/plot-cli";
import { UserPlotClient } from "../plot-client/index.ts";
import { PlotQuestionAlreadyAnsweredError, PlotQuestionNotFoundError } from "./errors.ts";

export interface AnswerPlotQuestionRequest {
	/** Absolute path to the project's `.plot/` directory. */
	readonly plotDir: string;
	/** Target Plot id (`pt-xxxxxxxx`). */
	readonly plotId: string;
	/** Resolved dispatcher handle (already passed through `resolveDispatcherHandle`). */
	readonly handle: string;
	/**
	 * Wire `:event_id` — the `at` ISO timestamp of the `question_posed`
	 * event being answered. PlotEvent has no synthetic id, so `at` is the
	 * canonical identifier on the wire.
	 */
	readonly eventId: string;
	/** Human-supplied answer text. Non-empty; validated at the handler edge. */
	readonly answer: string;
}

export interface AnswerPlotQuestionResult {
	/**
	 * The `question_answered` event the library appended for this
	 * answer. Returned alone (not wrapped in a full envelope) so the UI
	 * can splice it into the optimistic activity feed without a full
	 * re-render — the next `GET /plots/:id` reconciles the rest.
	 */
	readonly event: PlotEvent;
}

export interface PlotQuestionAnswerer {
	answer(input: AnswerPlotQuestionRequest): Promise<AnswerPlotQuestionResult>;
}

/**
 * Walk the event log and assert that `eventId` is an unanswered
 * `question_posed`. Throws `PlotQuestionNotFoundError` when no
 * `question_posed` with `at === eventId` exists, and
 * `PlotQuestionAlreadyAnsweredError` when a later event has
 * `type === "question_answered" && data.question_id === eventId`.
 *
 * Exported so the handler can run the same assertion against the
 * resolver-cached event log (defense in depth) before opening a
 * `UserPlotClient`. The answerer re-runs the assertion against the
 * fresh on-disk log to catch races between the handler's check and the
 * actual write.
 */
export function assertQuestionAnswerable(
	plotId: string,
	eventId: string,
	events: readonly PlotEvent[],
): void {
	let posedIndex = -1;
	for (let i = 0; i < events.length; i++) {
		const ev = events[i];
		if (ev === undefined) continue;
		if (ev.type === "question_posed" && ev.at === eventId) {
			posedIndex = i;
			break;
		}
	}
	if (posedIndex === -1) {
		throw new PlotQuestionNotFoundError(
			`plot ${plotId} has no question_posed event at ${eventId}`,
			{
				recoveryHint:
					"re-fetch the Plot via GET /plots/:id; the targeted question may have been archived, or :event_id may be a stale at timestamp",
			},
		);
	}
	for (let i = posedIndex + 1; i < events.length; i++) {
		const ev = events[i];
		if (ev === undefined) continue;
		if (ev.type !== "question_answered") continue;
		const qid = (ev.data as { question_id?: unknown }).question_id;
		if (qid === eventId) {
			throw new PlotQuestionAlreadyAnsweredError(
				`plot ${plotId} question ${eventId} already has a question_answered reply`,
				{
					recoveryHint:
						"re-fetch the Plot via GET /plots/:id; the answer-card affordance should disappear once the existing reply is visible",
				},
			);
		}
	}
}

/**
 * Production `PlotQuestionAnswerer`. Opens a `UserPlotClient`, reads
 * the event log to re-run `assertQuestionAnswerable` against the fresh
 * on-disk state (the handler-edge check uses the resolver cache, which
 * can lag a concurrent answer), appends the `question_answered` event
 * carrying `data.question_id = eventId`, then re-reads the log to find
 * the freshly appended event by matching both `type` and `question_id`
 * — the lib doesn't return the appended event from `append` in a
 * shape the handle re-narrows, so a tail walk is the stable contract.
 */
export const defaultPlotQuestionAnswerer: PlotQuestionAnswerer = {
	async answer(input) {
		const client = new UserPlotClient({
			dir: input.plotDir,
			actor: { kind: "user", handle: input.handle, raw: `user:${input.handle}` },
		});
		try {
			const handle = client.get(input.plotId);
			const before = await handle.events();
			assertQuestionAnswerable(input.plotId, input.eventId, before);
			const appended = await handle.append({
				type: "question_answered",
				data: { question_id: input.eventId, text: input.answer },
			});
			return { event: appended };
		} finally {
			client.close();
		}
	},
};
