import { useEffect } from "react";
import type { AgentRow, DefaultsConfig } from "@/api/types.ts";
import type { WalkDraftPatch } from "./walk-draft.ts";

/**
 * Per-project default auto-fill for the Dispatch plan page
 * (warren-02bb), mirroring `../dispatch/use-dispatch-defaults.ts`.
 *
 * Precedence the server applies at spawn — operator override >
 * project default (`.warren/config.yaml`) > agent row — is surfaced
 * here by auto-filling each field with the same value the server would
 * resolve, and stopping the moment the operator takes control of the
 * field (the `touched` flag).
 */

export type SetWalkDraft = (updater: (prev: WalkDraftPatch) => WalkDraftPatch) => void;

/**
 * Which source the current provider/model text came from — project
 * default, agent row, or an operator override — for the form hints.
 */
export function resolveDefaultKind(
	value: string,
	projectDefault: string | undefined,
	agentValue: string | null | undefined,
): "project" | "agent" | null {
	if (projectDefault !== undefined && projectDefault === value) return "project";
	if (agentValue !== null && agentValue !== undefined && agentValue === value && value.length > 0) {
		return "agent";
	}
	return null;
}

export function useWalkDefaults(
	defaults: DefaultsConfig | null,
	agents: readonly AgentRow[],
	selectedAgent: AgentRow | undefined,
	setPatch: SetWalkDraft,
): void {
	const defaultRole = defaults?.defaultRole;
	const defaultPrompt = defaults?.defaultPrompt;
	const defaultProvider = defaults?.defaultProvider;
	const defaultModel = defaults?.defaultModel;
	const defaultCostUsd = defaults?.maxCostUsd;

	const defaultRoleRegistered =
		defaultRole !== undefined && agents.some((a) => a.name === defaultRole);

	// Auto-fill the agent picker from the project's defaultRole while the
	// operator has not chosen one.
	useEffect(() => {
		if (!defaultRoleRegistered || defaultRole === undefined) return;
		setPatch((prev) =>
			prev.touched.agent || prev.draft.agent === defaultRole
				? prev
				: { ...prev, draft: { ...prev.draft, agent: defaultRole } },
		);
	}, [defaultRoleRegistered, defaultRole, setPatch]);

	// Auto-fill the prompt template from the project's defaultPrompt.
	useEffect(() => {
		if (defaultPrompt === undefined) return;
		setPatch((prev) =>
			prev.touched.prompt || prev.draft.promptTemplate === defaultPrompt
				? prev
				: { ...prev, draft: { ...prev.draft, promptTemplate: defaultPrompt } },
		);
	}, [defaultPrompt, setPatch]);

	// Provider: project default wins over the selected agent's row field
	// — the same precedence the server applies.
	const agentProvider = selectedAgent?.provider ?? "";
	const agentModel = selectedAgent?.model ?? "";
	const providerAutoFill =
		defaultProvider !== undefined && defaultProvider.length > 0 ? defaultProvider : agentProvider;
	const modelAutoFill =
		defaultModel !== undefined && defaultModel.length > 0 ? defaultModel : agentModel;

	useEffect(() => {
		setPatch((prev) =>
			prev.touched.provider || prev.draft.providerOverride === providerAutoFill
				? prev
				: { ...prev, draft: { ...prev.draft, providerOverride: providerAutoFill } },
		);
	}, [providerAutoFill, setPatch]);

	useEffect(() => {
		setPatch((prev) =>
			prev.touched.model || prev.draft.modelOverride === modelAutoFill
				? prev
				: { ...prev, draft: { ...prev.draft, modelOverride: modelAutoFill } },
		);
	}, [modelAutoFill, setPatch]);

	// Cost cap: pre-fill the weakest source (project default) only while
	// untouched — a dispatch-time override wins server-side anyway.
	const costCapText = defaultCostUsd !== undefined ? String(defaultCostUsd) : "";
	useEffect(() => {
		if (costCapText.length === 0) return;
		setPatch((prev) =>
			prev.touched.costCap || prev.draft.costCap === costCapText
				? prev
				: { ...prev, draft: { ...prev.draft, costCap: costCapText } },
		);
	}, [costCapText, setPatch]);
}
