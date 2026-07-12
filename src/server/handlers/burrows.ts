/**
 * Burrows handlers (warren-599c / pl-9088 step 3).
 *
 * Multi-worker fan-out (warren-14ad / pl-9ba1 step 5). Extracted from
 * `handlers/index.ts` — see the original module doc for the full design
 * rationale.
 */

import type { Burrow, BurrowKind, BurrowState, HttpBurrowListFilter } from "@os-eco/burrow-cli";
import { withTransportMapping } from "../../burrow-client/client.ts";
import { LOCAL_WORKER_NAME } from "../../burrow-client/index.ts";
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
 * `GET /burrows` — list the single local burrow's burrows (warren-76c5).
 * Multi-worker fan-out was retired with the K8s migration: warren's self-host
 * backend is exactly one local burrow, so this lists that one client's burrows
 * and sorts by `createdAt` ascending (oldest first). A transport failure lands
 * in the `workerErrors` envelope (shape preserved) rather than failing the
 * response.
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

		const client = deps.burrowClient;
		try {
			const rows = await withTransportMapping(client.config, () =>
				client.http.burrows.list(filter),
			);
			const burrows: Burrow[] = [...rows].sort(
				(a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
			);
			return jsonResponse(200, { burrows, workerErrors: [] });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			deps.logger?.warn?.({ op: "burrows.list", err: message }, "worker_unreachable");
			return jsonResponse(200, {
				burrows: [],
				workerErrors: [{ worker: LOCAL_WORKER_NAME, message }],
			});
		}
	};
}

/**
 * Targeted `GET /burrows/:id` (warren-76c5). Forwards to the single local
 * burrow client. Burrows warren has no `burrows` row for return 404 — they are
 * not warren-managed even if the burrow has them on disk.
 */
export function getBurrowHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast for burrows warren never recorded, preserving not-found
		// semantics rather than surfacing a raw burrow error.
		if ((await deps.repos.burrows.get(id)) === null) {
			throw new NotFoundError(`burrow not found: ${id}`, {
				recoveryHint:
					"warren has no record for this burrow id; it may belong to another control plane",
			});
		}
		const client = deps.burrowClient;
		const burrow = await withTransportMapping(client.config, () => client.http.burrows.get(id));
		return jsonResponse(200, burrow);
	};
}
