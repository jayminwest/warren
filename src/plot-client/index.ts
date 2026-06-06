/**
 * Public re-exports for the plot-client facade. Internal modules
 * import from here so the `plot-client/` layout can move without
 * touching call sites.
 *
 * See ./client.ts for the construction contract and ./handle.ts for
 * the type-narrowed mutating surfaces.
 */

export {
	AgentPlotClient,
	isAgentPlotClient,
	isUserPlotClient,
	openPlotClient,
	PLOT_INDEX_FILENAME,
	type PlotClientOptions,
	UserPlotClient,
} from "./client.ts";
export { PlotAgentACLViolationError } from "./errors.ts";
export {
	type AgentAppendInput,
	AgentPlotHandle,
	type AnyPlotHandle,
	type UserAppendInput,
	UserPlotHandle,
} from "./handle.ts";
export type { PlotProjectionSink } from "./projection.ts";
export {
	type AgentAllowedEventType,
	HUMANS_ONLY_EVENT_TYPES,
	type HumansOnlyEventType,
	isHumansOnlyEventType,
} from "./types.ts";
