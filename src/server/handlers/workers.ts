/**
 * Workers admin handlers (warren-0f0c / pl-9ba1 step 6).
 *
 * Extracted from `handlers/index.ts` (warren-599c / pl-9088 step 3).
 */

import { withTransportMapping } from "../../burrow-client/client.ts";
import { ValidationError } from "../../core/errors.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { readJsonBodyOrEmpty, requireParam } from "./index.ts";

/**
 * `GET /workers` — list every worker warren knows about with its current
 * probe-derived state. Operator-facing: shows whether the pool is healthy,
 * which workers are draining, and surfaces drift between `workers` rows
 * and pool registration so the operator can spot a missing `[workers]`
 * config entry.
 */
export function listWorkersHandler(deps: ServerDeps): RouteHandler {
	return async () => {
		const rows = await deps.repos.workers.listAll();
		const registered = new Set(deps.burrowClientPool.names());
		const workers = rows.map((row) => ({
			name: row.name,
			url: row.url,
			state: row.state,
			addedAt: row.addedAt,
			registered: registered.has(row.name),
		}));
		return jsonResponse(200, { workers });
	};
}

/**
 * `POST /workers/:name/drain` — flip warren's drain bit for the named
 * worker. Two side effects, in order:
 *
 *   1. Issue `POST /admin/drain {drain: <body.drain>}` against the burrow
 *      worker so its own dispatcher rejects new `POST /burrows` /
 *      `POST /burrows/:id/runs` with 503 `worker_draining`. This is the
 *      authoritative state on the burrow side; in-flight runs and
 *      streaming reads keep working.
 *   2. Update warren's `workers.state` so placement (`placeForProject`)
 *      skips this worker for new burrows. Setting `drain: true` flips
 *      the row to `draining`; setting `drain: false` flips it back to
 *      `healthy` (the probe loop reconciles to `unreachable` if the
 *      worker is actually down).
 *
 * Failure mode: if the burrow call fails (older burrow without
 * `/admin/drain`, network blip, auth mismatch), the error bubbles up
 * unchanged and warren's row is NOT touched — operators retry once
 * burrow is reachable, rather than warren silently drifting from the
 * worker's actual state.
 */
export function drainWorkerHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const name = requireParam(ctx, "name");
		const body = await readJsonBodyOrEmpty(ctx);
		const drain = body !== null ? parseDrainFlag(body) : true;

		const row = await deps.repos.workers.require(name);
		const client = deps.burrowClientPool.get(row.name);

		await withTransportMapping(client.config, () => client.setDrain(drain));

		const nextState = drain ? "draining" : "healthy";
		const updated = await deps.repos.workers.setState(row.name, nextState);
		return jsonResponse(200, {
			name: updated.name,
			state: updated.state,
			drain,
		});
	};
}

/**
 * Parse the optional `drain` body flag. Defaults to `true` when the
 * body is empty (the common case — operators want a one-shot drain
 * with no body). An explicit `false` un-drains.
 */
function parseDrainFlag(body: Record<string, unknown>): boolean {
	const raw = body.drain;
	if (raw === undefined) return true;
	if (typeof raw !== "boolean") {
		throw new ValidationError("field 'drain' must be a boolean");
	}
	return raw;
}
