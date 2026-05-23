/**
 * PlotClient — warren's typed facade over `@os-eco/plot-cli`'s
 * `PlotStore` + `SQLitePlotIndex`. Constructed once per `.plot/`
 * directory + actor pair; mirrors the role `BurrowClient` plays for
 * `@os-eco/burrow-cli`'s `HttpClient` (see ../burrow-client/client.ts).
 *
 * Why a facade rather than direct library use:
 *   1. Actor-keyed return type. Constructing through `openPlotClient`
 *      returns a `UserPlotClient` when the actor is `user:*` and an
 *      `AgentPlotClient` when it is `agent:*`. The two clients hand
 *      out matching `UserPlotHandle` / `AgentPlotHandle` types whose
 *      mutating surfaces differ — the type system refuses any agent
 *      code path that tries to call `editIntent`, `setStatus`,
 *      `detach`, or `append({type: "question_answered", ...})`.
 *      That guarantee mirrors SPEC §6 one level up from the Plot
 *      library's runtime `assertCanEmit`.
 *   2. Default index location. Plot's `SQLitePlotIndex` takes any
 *      path; warren always stores it at `<.plot>/.index.db` (Plot
 *      SPEC §5.2). Centralizing the join keeps every warren call site
 *      consistent.
 *   3. Single close path. `SQLitePlotIndex.close()` is the only
 *      resource that needs lifecycle management — the facade exposes
 *      it as a method on the client so callers don't have to reach
 *      into `.index`.
 *
 * What it deliberately does *not* add:
 *   - No env-driven construction. Plot directories are
 *     project-scoped; the project record (added in warren-4e20) tells
 *     warren where to open. Env-loading would imply a process-wide
 *     default, which doesn't fit the per-project shape.
 *   - No retry/backoff. Plot writes are local filesystem operations;
 *     a failure here is structural and should surface.
 *   - No event mirroring back into warren's event stream. That's
 *     reap-time work (warren-7e0f); doing it inside the client would
 *     couple the facade to warren's run state.
 */

import { join } from "node:path";
import {
	type Actor,
	type AgentActor,
	type Plot,
	type PlotEvent,
	PlotStore,
	SQLitePlotIndex,
	type UserActor,
} from "@os-eco/plot-cli";
import { AgentPlotHandle, UserPlotHandle } from "./handle.ts";

export const PLOT_INDEX_FILENAME = ".index.db";

export interface PlotClientOptions<A extends Actor = Actor> {
	/** Path to the project's `.plot/` directory. */
	readonly dir: string;
	/** Override the index DB path. Defaults to `<dir>/.index.db`. */
	readonly indexPath?: string;
	/** Plot actor making writes through this client. */
	readonly actor: A;
}

abstract class BasePlotClient<A extends Actor, H extends UserPlotHandle | AgentPlotHandle> {
	readonly dir: string;
	readonly actor: A;
	readonly index: SQLitePlotIndex;
	protected readonly store: PlotStore;

	constructor(opts: PlotClientOptions<A>) {
		this.dir = opts.dir;
		this.actor = opts.actor;
		this.index = new SQLitePlotIndex(opts.indexPath ?? join(opts.dir, PLOT_INDEX_FILENAME));
		this.store = new PlotStore({ dir: opts.dir, index: this.index, actor: opts.actor });
	}

	abstract get(plotId: string): H;

	list(): Promise<string[]> {
		return this.store.list();
	}

	query(q?: Parameters<SQLitePlotIndex["query"]>[0]) {
		return this.index.query(q);
	}

	rebuildIndex(): Promise<void> {
		return this.index.rebuild(this.dir);
	}

	close(): void {
		this.index.close();
	}
}

export class UserPlotClient extends BasePlotClient<UserActor, UserPlotHandle> {
	get(plotId: string): UserPlotHandle {
		return new UserPlotHandle(this.store.get(plotId));
	}

	// `plot_created` is allowed for both user and agent actors per SPEC §6,
	// but creating Plots from inside warren is a user-facing action only —
	// agent-actor flows attach to an existing Plot. Keeping `create` on the
	// user client makes that intent explicit at the type level.
	create(input: Parameters<PlotStore["create"]>[0]): Promise<UserPlotHandle> {
		return this.store.create(input).then((handle) => new UserPlotHandle(handle));
	}

	/**
	 * Rename a Plot in-place (warren-bed0 / pl-b0c0 step 3). Mutates
	 * `plot.json#/name` under the same per-Plot file lock the lib uses
	 * for `editIntent` / `setStatus`, and appends a `note` event with
	 * the from→to transition so the change is auditable in the event
	 * log (plot-cli v0.3 has no `plot_renamed` event type; the note is
	 * the closest first-class fit until upstream adds one).
	 *
	 * No-op if `newName` matches the current name. Throws if `newName`
	 * is empty after trim (the lib's create() refuses empty names; we
	 * mirror that invariant here so the on-disk Plot stays valid).
	 */
	async rename(plotId: string, newName: string): Promise<{ plot: Plot; event: PlotEvent | null }> {
		const trimmed = newName.trim();
		if (trimmed.length === 0) {
			throw new Error("UserPlotClient.rename: name must not be empty");
		}
		let emitted: PlotEvent | null = null;
		const { plot } = await this.store.transact(plotId, (current, now) => {
			if (current.name === trimmed) {
				return { next: current, events: [] };
			}
			const actorStr = `${this.actor.kind}:${this.actor.handle}`;
			const event: PlotEvent = {
				type: "note",
				actor: actorStr,
				at: now,
				data: {
					text: `renamed from ${JSON.stringify(current.name)} to ${JSON.stringify(trimmed)}`,
				},
			};
			emitted = event;
			return { next: { ...current, name: trimmed }, events: [event] };
		});
		return { plot, event: emitted };
	}
}

export class AgentPlotClient extends BasePlotClient<AgentActor, AgentPlotHandle> {
	get(plotId: string): AgentPlotHandle {
		return new AgentPlotHandle(this.store.get(plotId));
	}
}

/**
 * Construct the right client subclass for the given actor. Use this
 * when the actor is not known at compile time (e.g. resolved from a
 * request header); use `new UserPlotClient` / `new AgentPlotClient`
 * directly when the actor kind is statically known and you want the
 * narrowed type without a `narrowPlotClient` follow-up.
 */
export function openPlotClient(opts: PlotClientOptions): UserPlotClient | AgentPlotClient {
	if (opts.actor.kind === "user") {
		return new UserPlotClient({ ...opts, actor: opts.actor });
	}
	return new AgentPlotClient({ ...opts, actor: opts.actor });
}

export function isAgentPlotClient(
	client: UserPlotClient | AgentPlotClient,
): client is AgentPlotClient {
	return client instanceof AgentPlotClient;
}

export function isUserPlotClient(
	client: UserPlotClient | AgentPlotClient,
): client is UserPlotClient {
	return client instanceof UserPlotClient;
}
