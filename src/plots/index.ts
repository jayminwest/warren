/**
 * Public re-exports for the Plot aggregation module
 * (warren-7e85 / pl-9d6a step 1).
 *
 * Handlers and the resolver consume this barrel so the internal
 * layout (aggregate.ts / resolver.ts / types.ts) can move without
 * touching call sites — same pattern as `src/plot-client/index.ts`.
 */

export {
	type AggregatorClientFactory,
	type AggregatorPlotClient,
	type AggregatorRunsRepo,
	createPlotAggregator,
	defaultAggregatorClientFactory,
	EMPTY_PLOT_SUMMARIES,
	type ListPlotSummariesQuery,
	type PlotAggregator,
	type PlotAggregatorOptions,
	type PlotNeedsAttentionSummary,
} from "./aggregate.ts";
export {
	type AttachPlotRequest,
	type AttachPlotResult,
	type DetachPlotRequest,
	type DetachPlotResult,
	defaultPlotAttacher,
	type PlotAttacher,
} from "./attacher.ts";
export {
	type CreatePlotIntentPatch,
	type CreatePlotRequest,
	type CreatePlotResult,
	defaultPlotCreator,
	type PlotCreator,
} from "./creator.ts";
export {
	PlotAttachmentNotFoundError,
	PlotIdInvalidError,
	PlotIdNotFoundError,
	PlotIllegalStatusTransitionError,
	PlotIntentFrozenError,
	PlotPrAttachmentInvalidError,
	PlotPrAttachmentMismatchedKindError,
	PlotQuestionAlreadyAnsweredError,
	PlotQuestionNotFoundError,
} from "./errors.ts";
export {
	createDefaultPlotFormalizer,
	type DefaultPlotFormalizerDeps,
	extractSuggestedIntent,
	type FormalizePlotRequest,
	type FormalizePlotResult,
	type PlotFormalizer,
	type SuggestedIntent,
} from "./formalize.ts";
export { isValidPlotIdFormat, PLOT_ID_REGEX } from "./id-validator.ts";
export {
	assertIntentMutable,
	defaultPlotIntentEditor,
	type EditPlotIntentPatch,
	type EditPlotIntentRequest,
	type EditPlotIntentResult,
	type PlotIntentEditor,
} from "./intent-editor.ts";
export {
	computeNeedsAttentionReasons,
	DEFAULT_STALE_DRAFT_DAYS,
	NEEDS_ATTENTION_REASONS,
	type NeedsAttentionInputs,
	type NeedsAttentionReason,
} from "./needs-attention.ts";
export {
	defaultPlotPrMerger,
	type MergePlotPrRequest,
	type MergePlotPrResult,
	type PlotPrMerger,
} from "./pr-merger.ts";
export {
	type AnswerPlotQuestionRequest,
	type AnswerPlotQuestionResult,
	assertQuestionAnswerable,
	defaultPlotQuestionAnswerer,
	type PlotQuestionAnswerer,
} from "./question-answerer.ts";
export {
	defaultPlotReader,
	type PlotEnvelope,
	type PlotReader,
	type ReadPlotRequest,
	type ReadPlotResult,
} from "./reader.ts";
export { createPlotResolver, type PlotResolver, type PlotResolverOptions } from "./resolver.ts";
export {
	assertStatusTransitionAllowed,
	type ChangePlotStatusRequest,
	type ChangePlotStatusResult,
	defaultPlotStatusChanger,
	isLegalStatusTransition,
	type PlotStatusChanger,
	STATUS_TRANSITIONS,
} from "./status-changer.ts";
export {
	type PlotSummaryArtifact,
	type PlotSummaryDecision,
	type PlotSummaryLinkedCommit,
	type PlotSummaryLinkedPr,
	type PlotSummaryLinkedSeed,
	type PlotSummaryTimelineEntry,
	type SummarizePlotInput,
	summarizePlot,
	TIMELINE_KINDS,
	type TimelineKind,
} from "./summary.ts";
export {
	buildIntentGoalPreview,
	INTENT_GOAL_PREVIEW_MAX,
	type PlotSummary,
} from "./types.ts";
