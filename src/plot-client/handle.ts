/**
 * Type-narrowed wrappers around `@os-eco/plot-cli`'s `PlotHandle`.
 *
 * `UserPlotHandle` exposes the full mutating surface — intent edits,
 * status transitions, attach/detach, arbitrary `append`.
 * `AgentPlotHandle` exposes only the subset agents are allowed to
 * touch per SPEC §6: read, events, view, attach, and an `append`
 * narrowed to `AgentAllowedEventType`. The four humans-only event
 * types (`intent_edited`, `status_changed`, `attachment_removed`,
 * `question_answered`) are unreachable from this side of the boundary
 * — the first three because their dedicated mutators (`editIntent`,
 * `setStatus`, `detach`) don't exist on this class, and the fourth
 * because `append`'s generic parameter excludes it.
 *
 * The runtime guard inside `append` is defense in depth: if a caller
 * widens the type with `as` or feeds a dynamic event-type string from
 * a wire payload, we still refuse before reaching `PlotStore.append`
 * — see `PlotAgentACLViolationError`.
 */

import type {
	AgentActor,
	AttachInput,
	Attachment,
	Plot,
	PlotEvent,
	PlotEventType,
	PlotHandle,
	PlotStatus,
	UserActor,
} from "@os-eco/plot-cli";
import { PlotAgentACLViolationError } from "./errors.ts";
import type { PlotProjectionSink } from "./projection.ts";
import { type AgentAllowedEventType, isHumansOnlyEventType } from "./types.ts";

export interface AgentAppendInput<T extends AgentAllowedEventType> {
	type: T;
	data: Record<string, unknown>;
}

export interface UserAppendInput<T extends PlotEventType> {
	type: T;
	data: Record<string, unknown>;
}

abstract class BasePlotHandle {
	constructor(
		protected readonly inner: PlotHandle,
		/** Optional read-cache upsert seam (warren-7b60). */
		protected readonly projection?: PlotProjectionSink,
	) {}

	get id(): string {
		return this.inner.id;
	}

	async read(): Promise<Plot> {
		const plot = await this.inner.read();
		await this.syncProjection(plot);
		return plot;
	}

	events(): Promise<PlotEvent[]> {
		return this.inner.events();
	}

	// Plot v1 only knows the `implementer` view; the underlying handle
	// throws on anything else. Mirror that signature so the facade has
	// the same single-view contract.
	view(name: "implementer") {
		return this.inner.view(name);
	}

	async attach(input: AttachInput): Promise<Attachment> {
		const attachment = await this.inner.attach(input);
		await this.refreshProjection();
		return attachment;
	}

	/**
	 * Refresh the projection from a Plot the caller already has in hand
	 * (e.g. the return value of `editIntent` / `setStatus`). The sink is
	 * best-effort (see `PlotProjectionSink`); the `PlotClient` awaits it
	 * only so projection writes are deterministically ordered for tests.
	 */
	protected async syncProjection(plot: Plot): Promise<void> {
		if (!this.projection) return;
		await this.projection.upsert(plot);
	}

	/**
	 * Re-read the Plot and refresh the projection. Used after mutations
	 * whose return value is not the full Plot (`attach`/`detach`/`append`).
	 * Skips the extra read entirely when no sink is wired.
	 */
	protected async refreshProjection(): Promise<void> {
		if (!this.projection) return;
		await this.projection.upsert(await this.inner.read());
	}
}

export class UserPlotHandle extends BasePlotHandle {
	readonly actorKind: UserActor["kind"] = "user";

	async editIntent(patch: Parameters<PlotHandle["editIntent"]>[0]): Promise<Plot> {
		const plot = await this.inner.editIntent(patch);
		await this.syncProjection(plot);
		return plot;
	}

	async detach(attachmentId: string): Promise<void> {
		await this.inner.detach(attachmentId);
		await this.refreshProjection();
	}

	async setStatus(status: PlotStatus): Promise<Plot> {
		const plot = await this.inner.setStatus(status);
		await this.syncProjection(plot);
		return plot;
	}

	async append<T extends PlotEventType>(input: UserAppendInput<T>): Promise<PlotEvent> {
		const event = await this.inner.append(input);
		await this.refreshProjection();
		return event;
	}
}

export class AgentPlotHandle extends BasePlotHandle {
	readonly actorKind: AgentActor["kind"] = "agent";

	// Kept non-`async` so the ACL guard throws synchronously (an `async`
	// method would surface the violation as a rejected promise instead);
	// the projection refresh still chains off the real append.
	append<T extends AgentAllowedEventType>(input: AgentAppendInput<T>): Promise<PlotEvent> {
		if (isHumansOnlyEventType(input.type)) {
			throw new PlotAgentACLViolationError(input.type);
		}
		return this.inner.append(input).then(async (event) => {
			await this.refreshProjection();
			return event;
		});
	}
}

export type AnyPlotHandle = UserPlotHandle | AgentPlotHandle;
