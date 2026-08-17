import { INBOX_PRIORITIES } from "../../../core/wire.ts";
import {
	type CancelReap,
	cancelRun,
	pollRunInbox,
	reapRun,
	steerRun,
} from "../../../runs/index.ts";
import type { RuntimeProvider } from "../../../runtime/contract.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { optionalEnum } from "../body-fields.ts";
import {
	optionalString,
	readJsonBody,
	readJsonBodyOrEmpty,
	requireParam,
	requireString,
} from "../index.ts";

/**
 * The runtime provider + burrow-bound inline-reap seam `cancelRun` needs,
 * resolved from server deps (warren-b223). Centralized so the cancel handler and
 * the plan-run child-cancel bind identical wiring: the provider is the
 * boot-resolved instance (`deps.runtimeProvider`, warren-f796 — no burrow-client
 * fallback), and the reap seam is pre-bound with the boot-resolved preview
 * sidecar resolver (`deps.previewSidecars`, warren-e24d), present iff the runtime
 * advertises preview ports — the same closure the boot layer hands the bridge +
 * watchdog. Keeps `cancelRun` itself free of any burrow coupling.
 */
export function cancelRunWiring(deps: ServerDeps): {
	runtimeProvider: RuntimeProvider;
	reap: CancelReap;
} {
	const previewSidecars = deps.previewSidecars;
	return {
		runtimeProvider: deps.runtimeProvider,
		reap: (reapInput) =>
			reapRun({
				...reapInput,
				// warren-45e6: the inline reap's pr_open runs through the boot-resolved
				// forge. This single bind covers BOTH cancel call sites the Forge
				// migration owns — the plan-run cancel handler and the run
				// cancel/pause-resume handler (warren-b223 inline reap).
				forge: deps.forge,
				...(previewSidecars !== undefined ? { previewSidecars } : {}),
			}),
	};
}

export function steerRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		// warren-b27c: membership-checked against the canonical wire vocabulary
		// before anything persists. An unchecked cast let `{"priority":"CRITICAL"}`
		// reach the `run_inbox` row (TS-only enum, no SQL CHECK) and make the
		// delivery comparator non-total.
		const priority = optionalEnum(body, "priority", INBOX_PRIORITIES);
		const result = await steerRun({
			runId: id,
			body: requireString(body, "body"),
			repos: deps.repos,
			runtimeProvider: deps.runtimeProvider,
			broker: deps.broker,
			...(priority !== undefined ? { priority } : {}),
			...(optionalString(body, "fromActor") !== undefined
				? { fromActor: optionalString(body, "fromActor") as string }
				: {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, { message: result.message });
	};
}

/**
 * `GET /runs/:id/inbox` — the in-pod steering poll (pl-829f step 18 /
 * warren-3d0b). The K8s agent harness drains steering messages here; the claim
 * is poll-consume (atomically flips unread → delivered, race-safe). Gated by
 * the standard `WARREN_API_TOKEN` bearer like every other `/runs` route — the
 * pod carries the token warren injected at create time.
 */
export function pollRunInboxHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// warren-3305: `?peek=1` lists the unread queue WITHOUT claiming it.
		// A bare poll is poll-CONSUME — an operator "just checking" would steal
		// the message from the pod's steering poll. The pod never peeks.
		const peek = ctx.url.searchParams.get("peek");
		const result = await pollRunInbox({
			runId: id,
			repos: deps.repos,
			broker: deps.broker,
			...(peek === "1" || peek === "true" ? { claim: false } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});
		return jsonResponse(200, { messages: result.messages });
	};
}

export function cancelRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBodyOrEmpty(ctx);
		const reason = body !== null ? optionalString(body, "reason") : undefined;
		const result = await cancelRun({
			runId: id,
			repos: deps.repos,
			...cancelRunWiring(deps),
			broker: deps.broker,
			...(reason !== undefined ? { reason } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
			...(deps.autoOpenPr !== undefined ? { autoOpenPr: deps.autoOpenPr } : {}),
		});
		return jsonResponse(200, {
			state: result.state,
			alreadyTerminal: result.alreadyTerminal,
			sandboxRun: result.sandboxRun,
		});
	};
}
