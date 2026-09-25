import type { PreviewState } from "@/api/types.ts";

/** Operator wording for the preview panel's state badge (warren-8c85). */
export function formatPreviewStateLabel(state: PreviewState): string {
	switch (state) {
		case "live":
			return "Ready";
		case "starting":
			return "Starting";
		case "failed":
			return "Failed to start";
		case "torn-down":
			return "Torn down";
		default:
			return state;
	}
}
