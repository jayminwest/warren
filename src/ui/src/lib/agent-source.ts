// Server-side `AgentSource` is `"builtin" | "library"`
// (src/registry/builtins/index.ts; the per-project `.canopy/` tier was
// removed in warren-f787). The UI classifies on a coarser tier for badge
// rendering. The `project` tier is retained defensively for legacy rows.

export type AgentSourceTier = "builtin" | "library" | "project" | "unknown";

export interface ClassifiedAgentSource {
	tier: AgentSourceTier;
	label: string;
	projectId: string | null;
}

export function classifyAgentSource(source: string | undefined): ClassifiedAgentSource {
	if (source === undefined) return { tier: "unknown", label: "—", projectId: null };
	if (source === "builtin") return { tier: "builtin", label: "built-in", projectId: null };
	if (source === "library") return { tier: "library", label: "library", projectId: null };
	if (source.startsWith("project:")) {
		const id = source.slice("project:".length);
		return { tier: "project", label: "project", projectId: id.length > 0 ? id : null };
	}
	return { tier: "unknown", label: source, projectId: null };
}
