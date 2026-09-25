import type { AgentRow, ProjectRow } from "@/api/types.ts";
import { Input } from "@/components/ui/input.tsx";
import { Segmented } from "@/components/ui/segmented.tsx";
import { Select } from "@/components/ui/select.tsx";
import { StatusText } from "@/components/ui/status.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import {
	ControlSkeleton,
	defaultKindHint,
	projectLabel,
	submitOnModEnter,
} from "../dispatch/dispatch-form.tsx";
import { Field, FieldRow, FormSection, invalidClass } from "../dispatch/field.tsx";
import type { WalkDraft, WalkSourceMode } from "./walk-draft.ts";

/**
 * The Dispatch plan page's form (warren-02bb, restyled in warren-9474):
 * target, the steps to walk (a seeds plan or an ordered issue list), the
 * agent every step runs, per-step limits, and the prompt template. Reuses
 * the run form's Field scaffolding; the submit actions live in the summary
 * rail and reach this form through the `form` attribute.
 */

export const WALK_FORM_ID = "walk-form";

const MANUAL_PLAN = "__manual__";

const SOURCE_OPTIONS = [
	{ value: "plan", label: "A plan" },
	{ value: "issues", label: "A list of issues" },
] as const;

export interface WalkFormProps {
	readonly draft: WalkDraft;
	readonly agents: readonly AgentRow[];
	readonly projects: readonly ProjectRow[];
	readonly projectsLoading: boolean;
	readonly agentsLoading: boolean;
	readonly plansLoading: boolean;
	readonly selectedProject: ProjectRow | undefined;
	readonly hasSeeds: boolean;
	readonly agentDefaultFrom: { role: string; sourceFile: string } | null;
	readonly providerDefaultKind: "project" | "agent" | null;
	readonly modelDefaultKind: "project" | "agent" | null;
	readonly planOptions: readonly {
		id: string;
		label: string;
		status: string;
		childCount: number;
	}[];
	readonly planSelectorUnavailable: boolean;
	readonly openChildCount: number | null;
	readonly issueStatuses: readonly { id: string; status: string | null }[];
	readonly costCapError: string | null;
	readonly timeLimitError: string | null;
	readonly onProject: (value: string) => void;
	readonly onRef: (value: string) => void;
	readonly onPlanId: (value: string) => void;
	readonly onPlanIdManual: () => void;
	readonly onIssuesText: (value: string) => void;
	readonly onSourceMode: (mode: WalkSourceMode) => void;
	readonly onAgent: (value: string) => void;
	readonly onProvider: (value: string) => void;
	readonly onModel: (value: string) => void;
	readonly onPrompt: (value: string) => void;
	readonly onCostCap: (value: string) => void;
	readonly onTimeLimit: (value: string) => void;
	readonly onSubmit: () => void;
}

type SectionProps = WalkFormProps;

function TargetSection(p: SectionProps) {
	const defaultBranch = p.selectedProject?.defaultBranch;
	return (
		<FormSection title="Target" description="Where each step's run works">
			<Field label="Project" htmlFor="walk-project">
				{p.projectsLoading ? (
					<ControlSkeleton />
				) : (
					<Select
						id="walk-project"
						wrapperClassName="w-full"
						value={p.draft.project}
						onChange={(e) => p.onProject(e.target.value)}
					>
						<option value="" disabled>
							Pick a project…
						</option>
						{p.projects.map((proj) => (
							<option key={proj.id} value={proj.id}>
								{projectLabel(proj)}
								{proj.hasSeeds ? "" : " (no issue tracker)"}
							</option>
						))}
					</Select>
				)}
			</Field>
			<Field
				label="Git ref"
				htmlFor="walk-ref"
				optional
				hint={defaultBranch ? `Empty starts each step from ${defaultBranch}` : undefined}
			>
				<Input
					id="walk-ref"
					className="font-mono"
					value={p.draft.ref}
					onChange={(e) => p.onRef(e.target.value)}
					placeholder={defaultBranch ?? "Default branch"}
					disabled={!p.hasSeeds}
					autoComplete="off"
					spellCheck={false}
				/>
			</Field>
		</FormSection>
	);
}

function planHint(p: SectionProps): string {
	if (p.planSelectorUnavailable) {
		return p.selectedProject
			? "Warren couldn't list this project's plans. Type the plan id instead."
			: "Pick a project first.";
	}
	if (p.draft.planId.trim().length > 0 && p.openChildCount !== null) {
		return `${p.openChildCount} open ${p.openChildCount === 1 ? "step" : "steps"}, walked in the plan's order`;
	}
	return "Steps run in the plan's order";
}

function PlanPicker({ p }: { p: SectionProps }) {
	const d = p.draft;
	if (p.plansLoading) return <ControlSkeleton />;
	if (d.planIdManual || p.planSelectorUnavailable) {
		return (
			<Input
				id="walk-plan"
				className="font-mono"
				value={d.planId}
				onChange={(e) => p.onPlanId(e.target.value)}
				placeholder="pl-a258"
				disabled={!p.hasSeeds}
				autoComplete="off"
				spellCheck={false}
			/>
		);
	}
	const known = p.planOptions.some((opt) => opt.id === d.planId);
	return (
		<Select
			id="walk-plan"
			wrapperClassName="w-full"
			value={known ? d.planId : ""}
			onChange={(e) => {
				if (e.target.value === MANUAL_PLAN) p.onPlanIdManual();
				else p.onPlanId(e.target.value);
			}}
			disabled={!p.hasSeeds}
		>
			<option value="" disabled>
				Pick a plan…
			</option>
			{p.planOptions.map((opt) => (
				<option key={opt.id} value={opt.id}>
					{opt.label}
					{opt.status ? ` · ${opt.status}` : ""}
				</option>
			))}
			<option value={MANUAL_PLAN}>Type a plan id…</option>
		</Select>
	);
}

function IssueList({ p }: { p: SectionProps }) {
	if (p.issueStatuses.length === 0) return null;
	return (
		<ol className="divide-y divide-(--color-border) overflow-hidden rounded-sm border border-(--color-border)">
			{p.issueStatuses.map((issue, i) => (
				<li key={issue.id} className="flex h-9 items-center gap-3 px-3 text-sm">
					<span className="w-5 shrink-0 text-xs text-(--color-text-3) tabular-nums">{i + 1}</span>
					<span className="min-w-0 flex-1 truncate font-mono text-(--color-text)">{issue.id}</span>
					{issue.status !== null ? (
						<StatusText state={issue.status} className="shrink-0 text-xs" />
					) : null}
				</li>
			))}
		</ol>
	);
}

function StepsSection(p: SectionProps) {
	const d = p.draft;
	return (
		<FormSection title="Steps" description="One run per step, in order">
			<Segmented
				label="Where the steps come from"
				options={SOURCE_OPTIONS}
				value={d.sourceMode}
				onChange={p.onSourceMode}
				className="self-start"
			/>
			{d.sourceMode === "plan" ? (
				<Field label="Plan" htmlFor="walk-plan" hint={planHint(p)}>
					<PlanPicker p={p} />
				</Field>
			) : (
				<Field
					label="Issues"
					htmlFor="walk-issues"
					hint="One issue id per line. The list order is the walk order."
				>
					<Textarea
						id="walk-issues"
						rows={4}
						className="resize-y font-mono"
						value={d.issuesText}
						onChange={(e) => p.onIssuesText(e.target.value)}
						placeholder={"warren-93df\nwarren-4c1a\nwarren-b7e2"}
						disabled={!p.hasSeeds}
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
			)}
			{d.sourceMode === "issues" ? <IssueList p={p} /> : null}
			<p className="text-xs text-(--color-text-3)">
				Each step waits for the previous step's pull request to merge. Dispatching the same plan
				again picks up at the next open step.
			</p>
		</FormSection>
	);
}

function AgentSection(p: SectionProps) {
	const d = p.draft;
	return (
		<FormSection title="Agent" description="Runs every step">
			<Field
				label="Agent"
				htmlFor="walk-agent"
				hint={p.agentDefaultFrom ? "The project's default agent" : undefined}
			>
				{p.agentsLoading ? (
					<ControlSkeleton />
				) : (
					<Select
						id="walk-agent"
						wrapperClassName="w-full"
						value={d.agent}
						onChange={(e) => p.onAgent(e.target.value)}
						disabled={!p.hasSeeds}
					>
						<option value="" disabled>
							Pick an agent…
						</option>
						{p.agents.map((a) => (
							<option key={a.name} value={a.name}>
								{a.name}
							</option>
						))}
					</Select>
				)}
			</Field>
			<FieldRow>
				<Field
					label="Provider"
					htmlFor="walk-provider"
					hint={defaultKindHint(p.providerDefaultKind, d.providerOverride)}
				>
					<Input
						id="walk-provider"
						value={d.providerOverride}
						onChange={(e) => p.onProvider(e.target.value)}
						placeholder="anthropic"
						disabled={!p.hasSeeds}
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
				<Field
					label="Model"
					htmlFor="walk-model"
					hint={defaultKindHint(p.modelDefaultKind, d.modelOverride)}
				>
					<Input
						id="walk-model"
						value={d.modelOverride}
						onChange={(e) => p.onModel(e.target.value)}
						placeholder="claude-sonnet-4-6"
						disabled={!p.hasSeeds}
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
			</FieldRow>
		</FormSection>
	);
}

function LimitsSection(p: SectionProps) {
	return (
		<FormSection title="Limits" description="Optional, applied to each step">
			<FieldRow>
				<Field
					label="Spend cap per step (USD)"
					htmlFor="walk-cost-cap"
					optional
					error={p.costCapError}
					hint="A step's run stops when its spend crosses this"
				>
					<Input
						id="walk-cost-cap"
						className={invalidClass(p.costCapError)}
						aria-invalid={p.costCapError !== null}
						value={p.draft.costCap}
						onChange={(e) => p.onCostCap(e.target.value)}
						placeholder="5.00"
						inputMode="decimal"
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
				<Field
					label="Time limit per step (minutes)"
					htmlFor="walk-time-limit"
					optional
					error={p.timeLimitError}
					hint="Applies to every step's run: it is stopped and marked timed out after this long"
				>
					<Input
						id="walk-time-limit"
						className={invalidClass(p.timeLimitError)}
						aria-invalid={p.timeLimitError !== null}
						value={p.draft.timeLimit}
						onChange={(e) => p.onTimeLimit(e.target.value)}
						placeholder="60"
						inputMode="numeric"
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
			</FieldRow>
		</FormSection>
	);
}

function PromptSection(p: SectionProps) {
	return (
		<FormSection title="Prompt" description="What each step's agent is told">
			<Field
				label="Prompt template"
				htmlFor="walk-prompt"
				hint="{seed_id} becomes each step's issue id. The project's context is added when each run starts."
			>
				<Textarea
					id="walk-prompt"
					rows={3}
					className="resize-y"
					value={p.draft.promptTemplate}
					onChange={(e) => p.onPrompt(e.target.value)}
					onKeyDown={submitOnModEnter}
					placeholder="work on sd {seed_id}"
					disabled={!p.hasSeeds}
				/>
			</Field>
		</FormSection>
	);
}

export function WalkForm(props: WalkFormProps) {
	return (
		<form
			id={WALK_FORM_ID}
			className="flex w-full min-w-0 max-w-3xl flex-1 flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				props.onSubmit();
			}}
		>
			<TargetSection {...props} />
			<StepsSection {...props} />
			<AgentSection {...props} />
			<LimitsSection {...props} />
			<PromptSection {...props} />
		</form>
	);
}
