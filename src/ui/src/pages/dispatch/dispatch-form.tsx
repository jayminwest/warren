import type { ReactNode } from "react";
import type { AgentRow, ProjectRow } from "@/api/types.ts";
import {
	responsiveFooterActions,
	responsiveFooterButton,
	responsiveFormControl,
} from "@/components/ui/responsive.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Left rail of the Direction C Dispatch page (warren-bbe8): the workload
 * definition form, translated from `docs/ui-revamp/screens/dispatch.jsx`.
 * Token variables only — dark and light themes both render off
 * `src/ui/src/tokens.css`.
 */

const controlClass = cn(
	responsiveFormControl,
	"w-full rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-bg) px-2.5 leading-[17px] text-(--color-text) placeholder:text-(--color-text-3) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary)",
	"sm:h-8 sm:text-[11px] sm:leading-[14px]",
);

const labelClass = "text-[10px] font-medium leading-3 text-(--color-text-2)";
const hintClass = "font-mono text-[9px] leading-3 text-(--color-text-3)";

function Section({
	title,
	description,
	children,
	last = false,
}: {
	title: string;
	description: string;
	children: ReactNode;
	last?: boolean;
}) {
	return (
		<section className={`flex flex-col p-[15px] ${last ? "" : "border-b border-(--color-border)"}`}>
			<div className="flex flex-col gap-[3px] pb-[13px]">
				<h2 className="text-[11px] font-semibold leading-[14px] text-(--color-text)">{title}</h2>
				<p className="text-[10px] leading-3 text-(--color-text-3)">{description}</p>
			</div>
			{children}
		</section>
	);
}

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-[5px]">
			<span className={labelClass}>{label}</span>
			{children}
			{hint ? <p className={hintClass}>{hint}</p> : null}
		</div>
	);
}

export interface DispatchFormProps {
	agents: readonly AgentRow[];
	projects: readonly ProjectRow[];
	agentDefaultFrom: { role: string; sourceFile: string } | null;
	selectedProject: ProjectRow | undefined;
	agent: string;
	project: string;
	ref: string;
	seedId: string;
	prompt: string;
	providerOverride: string;
	modelOverride: string;
	costCap: string;
	providerDefaultKind: "project" | "agent" | null;
	modelDefaultKind: "project" | "agent" | null;
	costCapError: string | null;
	submitError: string | null;
	pending: boolean;
	onAgent: (value: string) => void;
	onProject: (value: string) => void;
	onRef: (value: string) => void;
	onSeedId: (value: string) => void;
	onPrompt: (value: string) => void;
	onProvider: (value: string) => void;
	onModel: (value: string) => void;
	onCostCap: (value: string) => void;
	onCancel: () => void;
	/** Fires on form submission (Enter key or the Dispatch button). */
	onSubmit: () => void;
}

export function DispatchForm(props: DispatchFormProps) {
	const canSubmit =
		!props.pending &&
		props.agent.length > 0 &&
		props.project.length > 0 &&
		props.prompt.trim().length > 0 &&
		props.costCapError === null;

	return (
		<form
			className="flex min-w-0 max-w-[760px] flex-1 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)"
			onSubmit={(e) => {
				e.preventDefault();
				if (canSubmit) props.onSubmit();
			}}
		>
			<Section
				title="Target"
				description="Warren materializes this repository in a new isolated workspace."
			>
				<div className="flex flex-col gap-[5px] pb-[12px]">
					<Field
						label="Project"
						hint={props.project.length > 0 ? `PROJECT ID ${props.project}` : undefined}
					>
						<select
							className={controlClass}
							value={props.project}
							onChange={(e) => props.onProject(e.target.value)}
						>
							<option value="" disabled>
								Pick a project…
							</option>
							{props.projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.gitUrl} ({p.id}){p.hasSeeds ? "" : " — no .seeds/"}
								</option>
							))}
						</select>
					</Field>
				</div>
				<div className="flex gap-[12px]">
					<Field
						label="Git ref"
						hint={
							props.selectedProject ? `DEFAULT ${props.selectedProject.defaultBranch}` : undefined
						}
					>
						<input
							className={controlClass}
							value={props.ref}
							onChange={(e) => props.onRef(e.target.value)}
							placeholder={props.selectedProject?.defaultBranch ?? "default branch"}
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
					<Field label="Tracker item" hint="OPTIONAL · ATTACHED TO RUN RECORD">
						<input
							className={controlClass}
							value={props.seedId}
							onChange={(e) => props.onSeedId(e.target.value)}
							placeholder="e.g. warren-b6f2"
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
				</div>
			</Section>

			<Section
				title="Agent runtime"
				description="Select the adapter and model configuration Warren will operate."
			>
				<div className="flex flex-col gap-[5px] pb-[12px]">
					<Field
						label="Agent"
						hint={
							props.agentDefaultFrom
								? `PROJECT DEFAULT · ${props.agentDefaultFrom.sourceFile}`
								: undefined
						}
					>
						<select
							className={controlClass}
							value={props.agent}
							onChange={(e) => props.onAgent(e.target.value)}
						>
							<option value="" disabled>
								Pick an agent…
							</option>
							{props.agents.map((a) => (
								<option key={a.name} value={a.name}>
									{a.name}
									{a.source ? ` · ${a.source}` : ""}
								</option>
							))}
						</select>
					</Field>
				</div>
				<div className="flex gap-[12px]">
					<Field
						label="Provider"
						hint={
							props.providerDefaultKind === "project"
								? "PROJECT DEFAULT"
								: props.providerDefaultKind === "agent"
									? "AGENT DEFAULT"
									: "OVERRIDE · FREE TEXT"
						}
					>
						<input
							className={controlClass}
							value={props.providerOverride}
							onChange={(e) => props.onProvider(e.target.value)}
							placeholder="anthropic, openai, …"
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
					<Field
						label="Model"
						hint={
							props.modelDefaultKind === "project"
								? "PROJECT DEFAULT"
								: props.modelDefaultKind === "agent"
									? "AGENT DEFAULT"
									: "OVERRIDE · FREE TEXT"
						}
					>
						<input
							className={controlClass}
							value={props.modelOverride}
							onChange={(e) => props.onModel(e.target.value)}
							placeholder="claude-sonnet-4-6, gpt-4o, …"
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
				</div>
			</Section>

			<Section title="Intent" description="Put the judgment in the prompt before the run starts.">
				<div className="flex flex-col gap-[5px]">
					<span className={labelClass}>Prompt</span>
					<textarea
						className={cn(controlClass, "min-h-[104px] resize-y py-2 sm:leading-[17px]")}
						value={props.prompt}
						onChange={(e) => props.onPrompt(e.target.value)}
						placeholder="What should the agent do?"
					/>
					<p className={hintClass}>
						{props.prompt.length} CHARACTERS · PROJECT CONTEXT APPENDED AT DISPATCH
					</p>
				</div>
			</Section>

			<Section title="Guardrails" description="These limits remain outside the agent process." last>
				<div className="flex gap-[12px]">
					<Field
						label="Cost cap (USD)"
						hint={
							props.costCapError ?? "ENFORCED FROM LIVE USAGE EVENTS · WEAKEST: PROJECT DEFAULT"
						}
					>
						<input
							className={`${controlClass} ${props.costCapError ? "border-(--color-danger)" : ""} font-mono`}
							value={props.costCap}
							onChange={(e) => props.onCostCap(e.target.value)}
							placeholder="unset"
							inputMode="decimal"
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
					<Field label="Timeout" hint="NO PER-RUN TIMEOUT API YET">
						<select className={`${controlClass} opacity-60`} disabled value="">
							<option value="">—</option>
						</select>
					</Field>
				</div>
			</Section>

			<div className={cn(responsiveFooterActions, "px-[15px] py-[12px] sm:items-center")}>
				<p className={cn(hintClass, "sm:flex-1")}>
					Dispatch writes the run definition before admission.
				</p>
				<button
					type="button"
					onClick={props.onCancel}
					disabled={props.pending}
					className={cn(
						responsiveFooterButton,
						"flex h-11 items-center justify-center rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface) px-[11px] text-[11px] font-medium leading-[14px] text-(--color-text-2) hover:bg-(--color-surface-hover) disabled:opacity-50 sm:h-[31px] sm:justify-start",
					)}
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={!canSubmit}
					className={cn(
						responsiveFooterButton,
						"flex h-11 items-center justify-center rounded-(--radius-sm) bg-(--color-primary) px-[11px] text-[11px] font-medium leading-[14px] text-(--color-primary-ink) disabled:opacity-50 sm:h-[31px] sm:justify-start",
					)}
				>
					{props.pending ? "Dispatching…" : "Dispatch workload"}
				</button>
			</div>

			{props.submitError ? (
				<p className="border-t border-(--color-border) px-[15px] py-2 font-mono text-[10px] leading-3 text-(--color-danger)">
					{props.submitError}
				</p>
			) : null}
		</form>
	);
}
