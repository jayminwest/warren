/**
 * Burrows handlers (warren-599c / pl-9088 step 3).
 *
 * Multi-worker fan-out (warren-14ad / pl-9ba1 step 5). Extracted from
 * `handlers/index.ts` — see the original module doc for the full design
 * rationale.
 */

import type { Burrow, BurrowKind, BurrowState, HttpBurrowListFilter } from "@os-eco/burrow-cli";
import { withTransportMapping } from "../../burrow-client/client.ts";
import { fanOutAcrossWorkers } from "../../burrow-client/fanout.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { requireParam } from "./index.ts";

/** Whitelist of `Burrow.kind` values accepted on `?kind=`. `satisfies`
 * keeps the array bound to the union so a value that is not a `BurrowKind`
 * fails tsc; addition of a new kind upstream is silent (won't break the
 * route) and only matters once the operator wants to filter on it. */
const BURROW_KIND_VALUES = ["project", "task"] as const satisfies readonly BurrowKind[];
/** Whitelist of `Burrow.state` values accepted on `?state=`. See the
 * `BURROW_KIND_VALUES` note above for the satisfies pattern. */
const BURROW_STATE_VALUES = [
	"active",
	"stopped",
	"destroyed",
] as const satisfies readonly BurrowState[];

function parseBurrowKind(raw: string | null): BurrowKind | undefined {
	if (raw === null) return undefined;
	if (!(BURROW_KIND_VALUES as readonly string[]).includes(raw)) {
		throw new ValidationError(`kind must be one of ${BURROW_KIND_VALUES.join(", ")}; got '${raw}'`);
	}
	return raw as BurrowKind;
}

function parseBurrowState(raw: string | null): BurrowState | undefined {
	if (raw === null) return undefined;
	if (!(BURROW_STATE_VALUES as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`state must be one of ${BURROW_STATE_VALUES.join(", ")}; got '${raw}'`,
		);
	}
	return raw as BurrowState;
}

/**
 * Fan-out `GET /burrows` (warren-14ad, plan acceptance #4). Calls
 * `http.burrows.list(filter)` against every registered worker via
 * `fanOutAcrossWorkers`, unions the rows, and sorts the wire output by
 * `createdAt` ascending (oldest first; same order operators get from a
 * single-worker `burrow burrows list`).
 *
 * Per-worker rejections do not fail the response: the helper logs a
 * `worker_unreachable` warn line per drop-out and the handler surfaces
 * the same set in a `workerErrors` envelope so consumers see which
 * workers contributed and which fell out. Empty pool → 200 with empty
 * arrays.
 */
export function listBurrowsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const kind = parseBurrowKind(ctx.url.searchParams.get("kind"));
		const state = parseBurrowState(ctx.url.searchParams.get("state"));
		const projectRoot = ctx.url.searchParams.get("projectRoot");
		const filter: HttpBurrowListFilter = {
			...(kind !== undefined ? { kind } : {}),
			...(state !== undefined ? { state } : {}),
			...(projectRoot !== null ? { projectRoot } : {}),
		};

		const fan = await fanOutAcrossWorkers(
			deps.burrowClientPool,
			(client) => withTransportMapping(client.config, () => client.http.burrows.list(filter)),
			{ logger: deps.logger, op: "burrows.list" },
		);

		const burrows: Burrow[] = fan.results
			.flatMap((r) => r.value.map((b) => ({ burrow: b, workerName: r.workerName })))
			.sort((a, b) => a.burrow.createdAt.getTime() - b.burrow.createdAt.getTime())
			.map((entry) => entry.burrow);

		const workerErrors = fan.errors.map((e) => ({
			worker: e.workerName,
			message: e.error.message,
		}));

		return jsonResponse(200, { burrows, workerErrors });
	};
}

/**
 * Targeted `GET /burrows/:id` (warren-14ad). Resolves the owning worker
 * via `pool.clientFor({burrowId})` (sticky-by-burrow) and forwards the
 * call. Burrows warren has no placement row for return 404 — they are
 * not warren-managed even if a worker has them on disk. A pinned-but-
 * unreachable worker falls through as `StickyWorkerUnreachableError`
 * (503) rather than silently re-placing on another worker (plan risk #5).
 */
export function getBurrowHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast for burrows warren never recorded — `placeForBurrow` would
		// otherwise raise `NoEligibleWorkerError` and the generic 503 mapping
		// would lose the not-found semantics.
		if ((await deps.repos.burrows.get(id)) === null) {
			throw new NotFoundError(`burrow not found: ${id}`, {
				recoveryHint:
					"warren has no placement record for this burrow id; it may belong to another control plane",
			});
		}
		const { client } = await deps.burrowClientPool.clientFor({ burrowId: id });
		const burrow = await withTransportMapping(client.config, () => client.http.burrows.get(id));
		return jsonResponse(200, burrow);
	};
}
