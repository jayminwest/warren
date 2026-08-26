import type { PreviewState } from "@/api/types.ts";

/**
 * Header-chip label for the preview panel (warren-8c85). "SIDECAR ..."
 * mirrors the export's trailing mono status; the dot-level state lives
 * on the StatusIndicator below it.
 */
export function formatPreviewStateLabel(state: PreviewState): string {
	switch (state) {
		case "live":
			return "sidecar ready";
		case "starting":
			return "sidecar starting";
		case "failed":
			return "sidecar failed";
		case "torn-down":
			return "torn down";
		default:
			return state;
	}
}
