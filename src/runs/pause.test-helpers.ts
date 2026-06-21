import type { PlotEvent } from "@os-eco/plot-cli";
import type { PlotEventReader } from "./pause.ts";

export const PROJECT_ID = "prj_xxxxxxxxxxxx";
export const PLOT_ID = "plot-2976abc1";

export function makeAgentJson() {
	return {
		name: "claude-code",
		version: 1,
		sections: { system: "be helpful" },
		resolvedFrom: [],
		frontmatter: {},
	};
}

export function poseEvent(at: string, text = "what next?"): PlotEvent {
	return {
		type: "question_posed",
		actor: "agent:claude-code:run-1",
		at,
		data: { text },
	} as PlotEvent;
}

export function answerEvent(questionAt: string, text: string, at = `${questionAt}-A`): PlotEvent {
	return {
		type: "question_answered",
		actor: "user:alice",
		at,
		data: { question_id: questionAt, text },
	} as PlotEvent;
}

export function stubReader(events: readonly PlotEvent[]): PlotEventReader {
	return {
		async read() {
			return events;
		},
	};
}

export function multiPlotReader(map: Record<string, readonly PlotEvent[]>): PlotEventReader {
	return {
		async read({ plotId }) {
			return map[plotId] ?? [];
		},
	};
}
