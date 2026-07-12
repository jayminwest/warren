import type { MessagePriority } from "@os-eco/burrow-cli";
import { cancelRun, pollRunInbox, steerRun } from "../../../runs/index.ts";
import { resolveRuntimeProvider } from "../../../runtime/registry.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import {
	optionalString,
	readJsonBody,
	readJsonBodyOrEmpty,
	requireParam,
	requireString,
} from "../index.ts";

export function steerRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const result = await steerRun({
			runId: id,
			body: requireString(body, "body"),
			repos: deps.repos,
			runtimeProvider:
				deps.runtimeProvider ??
				resolveRuntimeProvider({
					burrowClient: () => deps.burrowClient,
					k8sRunInbox: () => deps.repos.runInbox,
				}),
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
			burrowClient: deps.burrowClient,
			runtimeProvider:
				deps.runtimeProvider ?? resolveRuntimeProvider({ burrowClient: () => deps.burrowClient }),
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
