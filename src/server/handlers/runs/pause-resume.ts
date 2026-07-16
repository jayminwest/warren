import {
	type CancelReap,
	cancelRun,
	pollRunInbox,
	reapRun,
	steerRun,
} from "../../../runs/index.ts";
import type { MessagePriority, RuntimeProvider } from "../../../runtime/contract.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
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
				...(previewSidecars !== undefined ? { previewSidecars } : {}),
			}),
	};
}

export function steerRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const result = await steerRun({
			runId: id,
			body: requireString(body, "body"),
			repos: deps.repos,
			runtimeProvider: deps.runtimeProvider,
			broker: deps.broker,
			...(optionalString(body, "priority") !== undefined
				? { priority: optionalString(body, "priority") as MessagePriority }
				: {}),
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
		const result = await pollRunInbox({
			runId: id,
			repos: deps.repos,
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
			burrowRun: result.burrowRun,
		});
	};
}
