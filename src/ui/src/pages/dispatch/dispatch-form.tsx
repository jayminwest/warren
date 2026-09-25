import type { KeyboardEvent } from "react";
import type { AgentRow, ProjectRow } from "@/api/types.ts";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Field, FieldRow, FormSection, invalidClass } from "./field.tsx";
import { repositoryLabel } from "./manifest-view.ts";

/**
 * The Dispatch page's form (warren-bbe8, restyled in warren-9474): one Card
 * per concern — where the run works, which agent, the task, and limits.
 * The submit actions live in the summary rail and reach this form through
 * the `form` attribute, so they sit beside what they will dispatch.
 */

export const DISPATCH_FORM_ID = "dispatch-form";

/** Loading placeholder shaped like a single control. */
export function ControlSkeleton() {
	return <Skeleton className="h-11 w-full sm:h-8" />;
}

/** ⌘/Ctrl+Enter in a textarea submits its form. */
export function submitOnModEnter(e: KeyboardEvent<HTMLTextAreaElement>): void {
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		e.currentTarget.form?.requestSubmit();
	}
}

/** Where a provider/model value came from, in operator words. */
export function defaultKindHint(kind: "project" | "agent" | null, value: string): string {
	if (kind === "project") return "Project default";
	if (kind === "agent") return "Agent default";
	return value.trim().length > 0 ? "Set for this dispatch" : "Empty uses the agent's default";
}

/** Project picker label: `owner/repo`, falling back to the raw URL. */
export function projectLabel(project: ProjectRow): string {
	return repositoryLabel(project.gitUrl) ?? project.gitUrl;
}

export interface DispatchFormProps {
	agents: readonly AgentRow[];
	projects: readonly ProjectRow[];
	projectsLoading: boolean;
	agentsLoading: boolean;
	agentDefaultFrom: { role: string; sourceFile: string } | null;
	selectedProject: ProjectRow | undefined;
	agent: string;
	project: string;
	/** Git ref draft value — named gitRef because `ref` is a reserved JSX prop. */
	gitRef: string;
	seedId: string;
	prompt: string;
	providerOverride: string;
	modelOverride: string;
	costCap: string;
	providerDefaultKind: "project" | "agent" | null;
	modelDefaultKind: "project" | "agent" | null;
	costCapError: string | null;
	onAgent: (value: string) => void;
	onProject: (value: string) => void;
	onRef: (value: string) => void;
	onSeedId: (value: string) => void;
	onPrompt: (value: string) => void;
	onProvider: (value: string) => void;
	onModel: (value: string) => void;
	onCostCap: (value: string) => void;
	/** Fires on form submission (Enter, ⌘Enter, or the Dispatch button). */
	onSubmit: () => void;
}

function TargetSection(props: DispatchFormProps) {
	const defaultBranch = props.selectedProject?.defaultBranch;
	return (
		<FormSection title="Target" description="Where the run works">
			<Field label="Project" htmlFor="dispatch-project">
				{props.projectsLoading ? (
					<ControlSkeleton />
				) : (
					<Select
						id="dispatch-project"
						wrapperClassName="w-full"
						value={props.project}
						onChange={(e) => props.onProject(e.target.value)}
					>
						<option value="" disabled>
							Pick a project…
						</option>
						{props.projects.map((p) => (
							<option key={p.id} value={p.id}>
								{projectLabel(p)}
							</option>
						))}
					</Select>
				)}
			</Field>
			<FieldRow>
				<Field
					label="Git ref"
					htmlFor="dispatch-ref"
					optional
					hint={defaultBranch ? `Empty starts from ${defaultBranch}` : undefined}
				>
					<Input
						id="dispatch-ref"
						className="font-mono"
						value={props.gitRef}
						onChange={(e) => props.onRef(e.target.value)}
						placeholder={defaultBranch ?? "Default branch"}
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
				<Field
					label="Issue"
					htmlFor="dispatch-issue"
					optional
					hint="Links the run to a tracker issue"
				>
					<Input
						id="dispatch-issue"
						className="font-mono"
						value={props.seedId}
						onChange={(e) => props.onSeedId(e.target.value)}
						placeholder="warren-1a2b"
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
			</FieldRow>
		</FormSection>
	);
}

function AgentSection(props: DispatchFormProps) {
	const selected = props.agents.find((a) => a.name === props.agent);
	const agentHint = props.agentDefaultFrom
		? "The project's default agent"
		: (selected?.description ?? undefined);
	return (
		<FormSection title="Agent" description="Who does the work">
			<Field label="Agent" htmlFor="dispatch-agent" hint={agentHint}>
				{props.agentsLoading ? (
					<ControlSkeleton />
				) : (
					<Select
						id="dispatch-agent"
						wrapperClassName="w-full"
						value={props.agent}
						onChange={(e) => props.onAgent(e.target.value)}
					>
						<option value="" disabled>
							Pick an agent…
						</option>
						{props.agents.map((a) => (
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
					htmlFor="dispatch-provider"
					hint={defaultKindHint(props.providerDefaultKind, props.providerOverride)}
				>
					<Input
						id="dispatch-provider"
						value={props.providerOverride}
						onChange={(e) => props.onProvider(e.target.value)}
						placeholder="anthropic"
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
				<Field
					label="Model"
					htmlFor="dispatch-model"
					hint={defaultKindHint(props.modelDefaultKind, props.modelOverride)}
				>
					<Input
						id="dispatch-model"
						value={props.modelOverride}
						onChange={(e) => props.onModel(e.target.value)}
						placeholder="claude-sonnet-4-6"
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
			</FieldRow>
		</FormSection>
	);
}

function TaskSection(props: DispatchFormProps) {
	const count = props.prompt.length;
	return (
		<FormSection title="Task" description="What the agent should do">
			<Field
				label="Prompt"
				htmlFor="dispatch-prompt"
				hint={`${count.toLocaleString()} ${count === 1 ? "character" : "characters"} · the project's context is added when the run starts`}
			>
				<Textarea
					id="dispatch-prompt"
					rows={7}
					className="resize-y"
					value={props.prompt}
					onChange={(e) => props.onPrompt(e.target.value)}
					onKeyDown={submitOnModEnter}
					placeholder="Describe the change: what to do, how to know it's done, and how to verify it."
				/>
			</Field>
		</FormSection>
	);
}

function LimitsSection(props: DispatchFormProps) {
	return (
		<FormSection title="Limits" description="Optional guardrails for this run">
			<FieldRow>
				<Field
					label="Spend cap (USD)"
					htmlFor="dispatch-cost-cap"
					optional
					error={props.costCapError}
					hint="The run stops when its spend crosses this"
				>
					<Input
						id="dispatch-cost-cap"
						className={invalidClass(props.costCapError)}
						aria-invalid={props.costCapError !== null}
						value={props.costCap}
						onChange={(e) => props.onCostCap(e.target.value)}
						placeholder="5.00"
						inputMode="decimal"
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
				{/* Timeout field lands with the per-run timeout API (warren-a112). */}
			</FieldRow>
		</FormSection>
	);
}

export function DispatchForm(props: DispatchFormProps) {
	return (
		<form
			id={DISPATCH_FORM_ID}
			className="flex w-full min-w-0 max-w-3xl flex-1 flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				props.onSubmit();
			}}
		>
			<TargetSection {...props} />
			<AgentSection {...props} />
			<TaskSection {...props} />
			<LimitsSection {...props} />
		</form>
	);
}
