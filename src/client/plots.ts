/**
 * Plot operations for {@link WarrenClient}, factored into free functions
 * (warren-fcc8) so the client class stays under its line budget. Inputs
 * accept camelCase for ergonomics; request bodies map to the wire's
 * snake_case (`project_id`, `dispatcher_handle`, `plot_id`) at the
 * boundary. Responses pass through unchanged — the wire envelope under
 * `/plots` is snake_case end-to-end (mirror of the on-disk
 * `@os-eco/plot-cli` shape).
 */
import type {
	ChangePlotStatusInput,
	ChangePlotStatusResponse,
	CreatePlotInput,
	EditPlotIntentInput,
	ListPlotsFilter,
	ListPlotsResponse,
	PlotEnvelope,
	PlotSummary,
	PlotSyncResponse,
} from "./types.ts";

/** Minimal request seam satisfied by {@link WarrenClient.request}. */
export interface PlotRequester {
	request<T>(path: string, init?: RequestInit): Promise<T>;
}

const JSON_POST = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

/**
 * `GET /plots[?status=&filter=needs_attention]` — cross-project Plot
 * list. Unknown status or filter values are rejected server-side with
 * 400. Empty result set when no `hasPlot=true` projects exist.
 */
export function listPlots(
	req: PlotRequester,
	filter: ListPlotsFilter = {},
): Promise<ListPlotsResponse> {
	const params = new URLSearchParams();
	if (filter.status !== undefined) params.set("status", filter.status);
	if (filter.needsAttention === true) params.set("filter", "needs_attention");
	const qs = params.toString();
	return req.request<ListPlotsResponse>(`/plots${qs.length > 0 ? `?${qs}` : ""}`);
}

/** `GET /plots/:id` — full Plot envelope (intent + attachments + event log). */
export function getPlot(req: PlotRequester, plotId: string): Promise<PlotEnvelope> {
	return req.request<PlotEnvelope>(`/plots/${encodeURIComponent(plotId)}`);
}

/**
 * `POST /plots` — create a draft Plot in the named project's `.plot/`
 * directory. Server requires `project.hasPlot === true` (otherwise 400
 * `project_lacks_plot`). Empty `name` is rejected; omit the field to
 * accept the `"Untitled Plot"` default. The optional `intent` patch is
 * applied on top of `PlotStore.create` defaults.
 */
export function createPlot(req: PlotRequester, input: CreatePlotInput): Promise<PlotSummary> {
	const body: Record<string, unknown> = { project_id: input.projectId };
	if (input.name !== undefined) body.name = input.name;
	if (input.intent !== undefined) body.intent = input.intent;
	if (input.dispatcherHandle !== undefined) body.dispatcher_handle = input.dispatcherHandle;
	return req.request<PlotSummary>("/plots", JSON_POST(body));
}

/**
 * `POST /plots/:id/intent` — edit the intent block. Flat top-level
 * fields (no `intent:` wrapper, unlike createPlot). Omitted fields are
 * left untouched; an empty patch is accepted as a no-op. Returns the
 * refreshed `PlotEnvelope`.
 */
export function editPlotIntent(
	req: PlotRequester,
	plotId: string,
	input: EditPlotIntentInput = {},
): Promise<PlotEnvelope> {
	const body: Record<string, unknown> = {};
	if (input.goal !== undefined) body.goal = input.goal;
	if (input.non_goals !== undefined) body.non_goals = input.non_goals;
	if (input.constraints !== undefined) body.constraints = input.constraints;
	if (input.success_criteria !== undefined) body.success_criteria = input.success_criteria;
	if (input.dispatcherHandle !== undefined) body.dispatcher_handle = input.dispatcherHandle;
	return req.request<PlotEnvelope>(`/plots/${encodeURIComponent(plotId)}/intent`, JSON_POST(body));
}

/**
 * `POST /plots/:id/status` — transition the Plot status. Server
 * validates the SPEC §6.5 transition matrix; invalid transitions return
 * 400 with a typed code.
 */
export function changePlotStatus(
	req: PlotRequester,
	plotId: string,
	input: ChangePlotStatusInput,
): Promise<ChangePlotStatusResponse> {
	const body: Record<string, unknown> = { next: input.next };
	if (input.dispatcherHandle !== undefined) body.dispatcher_handle = input.dispatcherHandle;
	return req.request<ChangePlotStatusResponse>(
		`/plots/${encodeURIComponent(plotId)}/status`,
		JSON_POST(body),
	);
}

/**
 * `POST /plots/:id/sync` — trigger a manual sync of the Plot's on-disk
 * state to GitHub. Returns `{kind:'no_op'}` when the working tree is
 * clean, or `{kind:'synced', ...}` with PR details when a sync branch
 * was opened/updated.
 */
export function syncPlot(req: PlotRequester, plotId: string): Promise<PlotSyncResponse> {
	return req.request<PlotSyncResponse>(`/plots/${encodeURIComponent(plotId)}/sync`, {
		method: "POST",
	});
}
