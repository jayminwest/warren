/**
 * Composite export for the plots handlers domain (warren-3f46 / pl-3255
 * step 1; phase 2 split warren-332b / pl-369d).
 *
 * The Plot HTTP surface is decomposed into per-concern domain files:
 *   - `detail.ts`      — `GET /plots/:id`, `GET /plots/:id/summary`
 *   - `list.ts`        — `GET /plots`, `POST /plots`, needs-attention count
 *   - `intent.ts`      — `POST /plots/:id/intent`, `POST /plots/:id/rename`
 *   - `status.ts`      — `POST /plots/:id/status`
 *   - `attachments.ts` — attach / detach / merge-PR
 *   - `sync.ts`        — `POST /plots/:id/sync` + background syncer
 *   - `workbench.ts`   — brainstorm / answer-question / formalize
 *   - `shared.ts`      — resolve-project / paused-runs / envelope helpers
 */

export {
	attachPlotHandler,
	detachPlotHandler,
	mergePlotPrAttachmentHandler,
} from "./attachments.ts";
export {
	getPlotHandler,
	getPlotSummaryHandler,
} from "./detail.ts";
export {
	editPlotIntentHandler,
	renamePlotHandler,
} from "./intent.ts";
export {
	createPlotHandler,
	listPlotsHandler,
	needsAttentionCountHandler,
} from "./list.ts";
export { changePlotStatusHandler } from "./status.ts";
export {
	syncPlotHandler,
	triggerBackgroundSync,
} from "./sync.ts";
export {
	answerPlotQuestionHandler,
	createBrainstormHandler,
	formalizePlotHandler,
} from "./workbench.ts";
