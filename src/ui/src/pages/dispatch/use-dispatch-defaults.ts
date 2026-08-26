import { useEffect } from "react";
import type { AgentRow, DefaultsConfig } from "@/api/types.ts";
import type { DispatchDraftPatch } from "./dispatch-draft.ts";

/**
 * Per-project default auto-fill for the Dispatch page (warren-bbe8),
 * ported from the legacy new-run form (R-02 / warren-618b).
 *
 * Precedence the server applies at spawn — operator override > project
 * default (`.warren/config.yaml`) > agent row — is surfaced here by
 * auto-filling each field with the same value the server would resolve,
 * and stopping the moment the operator takes control of the field
 * (the `touched` flag).
 */

export interface DispatchDefaultsInput {
	readonly defaults: DefaultsConfig | null;
	readonly agents: readonly AgentRow[];
	/** The currently selected agent's row, if any. */
	readonly selectedAgent: AgentRow | undefined;
}

export type SetDraft = (updater: (prev: DispatchDraftPatch) => DispatchDraftPatch) => void;

export type { DispatchDraftPatch };

export function useDispatchDefaults(input: DispatchDefaultsInput, setDraft: SetDraft): void {
	const { defaults, agents, selectedAgent } = input;

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
		setDraft((prev) => {
			if (prev.touched.agent || prev.draft.agent === defaultRole) return prev;
			return { ...prev, draft: { ...prev.draft, agent: defaultRole } };
		});
	}, [defaultRoleRegistered, defaultRole, setDraft]);

	// Auto-fill the prompt textarea from the project's defaultPrompt.
	useEffect(() => {
		if (defaultPrompt === undefined) return;
		setDraft((prev) => {
			if (prev.touched.prompt || prev.draft.prompt === defaultPrompt) return prev;
			return { ...prev, draft: { ...prev.draft, prompt: defaultPrompt } };
		});
	}, [defaultPrompt, setDraft]);

	// Provider: project default wins over the selected agent's row field
	// (warren-618b) — the same precedence the server applies.
	const agentProvider = selectedAgent?.provider ?? "";
	const agentModel = selectedAgent?.model ?? "";
	const providerAutoFill =
		defaultProvider !== undefined && defaultProvider.length > 0 ? defaultProvider : agentProvider;
	const modelAutoFill =
		defaultModel !== undefined && defaultModel.length > 0 ? defaultModel : agentModel;

	useEffect(() => {
		setDraft((prev) => {
			if (prev.touched.provider || prev.draft.providerOverride === providerAutoFill) return prev;
			return { ...prev, draft: { ...prev.draft, providerOverride: providerAutoFill } };
		});
	}, [providerAutoFill, setDraft]);

	useEffect(() => {
		setDraft((prev) => {
			if (prev.touched.model || prev.draft.modelOverride === modelAutoFill) return prev;
			return { ...prev, draft: { ...prev.draft, modelOverride: modelAutoFill } };
		});
	}, [modelAutoFill, setDraft]);

	// Cost cap: pre-fill the weakest source (project default) only while
	// untouched — a dispatch-time override wins server-side anyway.
	const costCapText = defaultCostUsd !== undefined ? String(defaultCostUsd) : "";
	useEffect(() => {
		if (costCapText.length === 0) return;
		setDraft((prev) => {
			if (prev.touched.costCap || prev.draft.costCap === costCapText) return prev;
			return { ...prev, draft: { ...prev.draft, costCap: costCapText } };
		});
	}, [costCapText, setDraft]);
}
