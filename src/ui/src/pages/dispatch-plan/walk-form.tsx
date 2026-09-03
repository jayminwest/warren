import type { AgentRow, ProjectRow } from "@/api/types.ts";
import {
	responsiveFooterActions,
	responsiveFooterButton,
	responsiveFormControl,
} from "@/components/ui/responsive.ts";
import { cn } from "@/lib/utils.ts";
import type { WalkDraft, WalkSourceMode } from "./walk-draft.ts";
import { Field, hintClass, labelClass, MobileCard, Section } from "./walk-sections.tsx";

/**
 * Left rail of the Direction C Dispatch plan page (warren-02bb): the
 * walk-definition form, translated from
 * `docs/ui-revamp/screens/dispatch-plan.jsx`. Token variables only —
 * dark and light themes both render off `src/ui/src/tokens.css`.
 *
 * Mobile arm (pl-4ab6 / warren-9e94): below md the single form card splits
 * into one `--color-thead`-headed card per section, ported from the settled
 * dispatch treatment (warren-5cf7); desktop is unchanged.
 */

const controlClass = cn(
	responsiveFormControl,
	"w-full rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-bg) px-2.5 leading-[17px] text-(--color-text) placeholder:text-(--color-text-3) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary) disabled:cursor-not-allowed disabled:opacity-60 sm:h-8 sm:text-[11px] sm:leading-[14px]",
);

function ModeButton({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`h-7 rounded-(--radius-sm) border px-[10px] text-[10px] font-medium leading-[14px] ${
				active
					? "border-(--color-border-strong) bg-(--color-surface-raised) text-(--color-text)"
					: "border-(--color-border) bg-(--color-surface) text-(--color-text-3)"
			}`}
		>
			{label}
		</button>
	);
}

export interface WalkFormProps {
	readonly draft: WalkDraft;
	readonly agents: readonly AgentRow[];
	readonly projects: readonly ProjectRow[];
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
	readonly submitError: string | null;
	readonly pending: boolean;
	readonly canSubmit: boolean;
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
	readonly onCancel: () => void;
	readonly onSubmit: () => void;
}

export function WalkForm(props: WalkFormProps) {
	return (
		<form
			className="flex min-w-0 max-w-[760px] flex-1 flex-col gap-3.5 md:gap-0 md:overflow-clip md:rounded-(--radius-md) md:border md:border-(--color-border) md:bg-(--color-surface)"
			onSubmit={(e) => {
				e.preventDefault();
				if (props.canSubmit) props.onSubmit();
			}}
		>
			<TargetSection {...props} />
			<RuntimeSection {...props} />
			<ChildrenSection {...props} />
			<GuardrailsSection {...props} />
			<IntentSection {...props} />
			<Footer {...props} />
		</form>
	);
}

type SectionProps = WalkFormProps;

function TargetSection(p: SectionProps) {
	const d = p.draft;
	return (
		<MobileCard title="Target">
			<Section title="Target" description="Where the child runs work.">
				<div className="flex flex-col gap-[5px] pb-[12px]">
					<Field
						label="Project"
						hint={d.project.length > 0 ? `PROJECT ID ${d.project}` : undefined}
					>
						<select
							className={controlClass}
							value={d.project}
							onChange={(e) => p.onProject(e.target.value)}
						>
							<option value="" disabled>
								Pick a project…
							</option>
							{p.projects.map((proj) => (
								<option key={proj.id} value={proj.id}>
									{proj.gitUrl} ({proj.id}){proj.hasSeeds ? "" : " — no .seeds/"}
								</option>
							))}
						</select>
					</Field>
				</div>
				{/* Two-up only at md+ — the pair doesn't fit below md (warren-9e94). */}
				<div className="flex flex-col gap-[12px] md:flex-row md:gap-[12px]">
					<Field
						label="Git ref"
						hint={p.selectedProject ? `DEFAULT ${p.selectedProject.defaultBranch}` : undefined}
					>
						<input
							className={controlClass}
							value={d.ref}
							onChange={(e) => p.onRef(e.target.value)}
							placeholder={p.selectedProject?.defaultBranch ?? "default branch"}
							disabled={!p.hasSeeds}
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
					<Field label="Source plan" hint={sourcePlanHint(p)}>
						{d.sourceMode === "issues" ? (
							<input className={controlClass} value="" disabled placeholder="issues listed below" />
						) : (
							<SourcePlanControl p={p} />
						)}
					</Field>
				</div>
				{p.planSelectorUnavailable && d.sourceMode === "plan" ? (
					<p className={hintClass}>
						{p.selectedProject
							? "PLAN LIST UNAVAILABLE — ENTER THE PLAN ID MANUALLY"
							: "PICK A PROJECT FIRST"}
					</p>
				) : null}
			</Section>
		</MobileCard>
	);
}

function sourcePlanHint(p: SectionProps): string | undefined {
	if (p.draft.sourceMode === "issues") return "EXPLICIT ISSUE LIST — ORDER IS THE WALK ORDER";
	if (p.draft.planId.trim().length === 0) return undefined;
	if (p.openChildCount !== null) return `READY · ${p.openChildCount} OPEN CHILDREN`;
	return "ORDER FROM THE PLAN";
}

function SourcePlanControl({ p }: { p: SectionProps }) {
	const d = p.draft;
	const manual = d.planIdManual || p.planSelectorUnavailable;
	if (manual) {
		return (
			<input
				className={controlClass}
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
		<select
			className={controlClass}
			value={known ? d.planId : ""}
			onChange={(e) => {
				if (e.target.value === "__manual__") {
					p.onPlanIdManual();
					return;
				}
				p.onPlanId(e.target.value);
			}}
			disabled={!p.hasSeeds}
		>
			<option value="" disabled>
				Pick a plan…
			</option>
			{p.planOptions.map((opt) => (
				<option key={opt.id} value={opt.id}>
					{opt.label}
					{opt.status ? ` — ${opt.status}` : ""}
				</option>
			))}
			<option value="__manual__">Enter plan ID manually…</option>
		</select>
	);
}

function RuntimeSection(p: SectionProps) {
	const d = p.draft;
	return (
		<MobileCard title="Agent runtime">
			<Section title="Agent runtime" description="Applies to every child run in the walk.">
				<div className="flex flex-col gap-[5px] pb-[12px]">
					<Field
						label="Agent"
						hint={
							p.agentDefaultFrom ? `PROJECT DEFAULT · ${p.agentDefaultFrom.sourceFile}` : undefined
						}
					>
						<select
							className={controlClass}
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
									{a.source ? ` · ${a.source}` : ""}
								</option>
							))}
						</select>
					</Field>
				</div>
				{/* Two-up only at md+ — the pair doesn't fit below md (warren-9e94). */}
				<div className="flex flex-col gap-[12px] md:flex-row md:gap-[12px]">
					<Field label="Provider" hint={defaultKindHint(p.providerDefaultKind)}>
						<input
							className={controlClass}
							value={d.providerOverride}
							onChange={(e) => p.onProvider(e.target.value)}
							placeholder="anthropic, openai, …"
							disabled={!p.hasSeeds}
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
					<Field label="Model" hint={defaultKindHint(p.modelDefaultKind)}>
						<input
							className={controlClass}
							value={d.modelOverride}
							onChange={(e) => p.onModel(e.target.value)}
							placeholder="claude-sonnet-4-6, gpt-4o, …"
							disabled={!p.hasSeeds}
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
				</div>
			</Section>
		</MobileCard>
	);
}

function defaultKindHint(kind: "project" | "agent" | null): string {
	if (kind === "project") return "PROJECT DEFAULT";
	if (kind === "agent") return "AGENT DEFAULT";
	return "OVERRIDE · FREE TEXT";
}

const childRowClass =
	"flex items-center gap-3 border-b border-(--color-border) px-[14px] py-[9px] last:border-b-0";

function ChildrenSection(p: SectionProps) {
	const d = p.draft;
	return (
		<MobileCard title="Children">
			<Section
				title="Children"
				description="The plan's open children in walk order. Each dispatches as its own run."
			>
				<div className="mb-[5px] flex gap-[6px]">
					<ModeButton
						active={d.sourceMode === "plan"}
						label="Plan source"
						onClick={() => p.onSourceMode("plan")}
					/>
					<ModeButton
						active={d.sourceMode === "issues"}
						label="Explicit issue list"
						onClick={() => p.onSourceMode("issues")}
					/>
				</div>
				{d.sourceMode === "issues" ? (
					<textarea
						className={cn(controlClass, "mb-[5px] min-h-[64px] resize-y py-2 sm:leading-[17px]")}
						value={d.issuesText}
						onChange={(e) => p.onIssuesText(e.target.value)}
						placeholder={"warren-93df\nwarren-4c1a\nwarren-b7e2"}
						disabled={!p.hasSeeds}
						autoComplete="off"
						spellCheck={false}
					/>
				) : null}
				<div className="flex flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
					<ChildrenTable p={p} />
				</div>
				<p className={`${hintClass} pt-[5px]`}>
					RE-DISPATCHING THE SAME PLAN RESUMES FROM THE NEXT OPEN CHILD
				</p>
			</Section>
		</MobileCard>
	);
}

function ChildrenTable({ p }: { p: SectionProps }) {
	const d = p.draft;
	if (d.sourceMode === "issues") {
		if (p.issueStatuses.length === 0) {
			return (
				<div className="px-[14px] py-[9px] font-mono text-[10px] leading-3 text-(--color-text-3)">
					ENTER ORDERED ISSUE IDS ABOVE — ONE PER LINE
				</div>
			);
		}
		return (
			<>
				{p.issueStatuses.map((issue, i) => (
					<div key={issue.id} className={childRowClass}>
						<span className="w-5 shrink-0 font-mono text-[11px] leading-[14px] text-(--color-text-3)">
							{String(i + 1).padStart(2, "0")}
						</span>
						<span className="w-24 shrink-0 font-mono text-[12px] leading-4 text-(--color-primary)">
							{issue.id}
						</span>
						<span className="min-w-0 flex-1 truncate text-[13px] leading-4 text-(--color-text-2)">
							Walk order {i + 1} of {p.issueStatuses.length}
						</span>
						<span className="shrink-0 font-mono text-[10px] leading-3 tracking-[0.06em] text-(--color-text-3)">
							{issue.status !== null ? issue.status.toUpperCase() : "LISTED"}
						</span>
					</div>
				))}
			</>
		);
	}
	return (
		<div className="px-[14px] py-[9px] font-mono text-[10px] leading-3 text-(--color-text-3)">
			{planChildrenSummary(d, p)}
		</div>
	);
}

function planChildrenSummary(d: WalkDraft, p: SectionProps): string {
	if (d.planId.trim().length === 0) return "PICK A SOURCE PLAN";
	if (p.openChildCount !== null) {
		return `${p.openChildCount} OPEN CHILDREN · SERVER WALKS THE PLAN'S CHILD ORDER`;
	}
	return "SERVER WALKS THE PLAN'S CHILD ORDER";
}

function GuardrailsSection(p: SectionProps) {
	const d = p.draft;
	return (
		<MobileCard title="Guardrails">
			<Section title="Guardrails" description="Optional limits, applied per child run.">
				<div className="flex gap-[12px]">
					<Field
						label="Cost cap per child (USD)"
						hint={p.costCapError ?? "ENFORCED FROM LIVE USAGE EVENTS"}
					>
						<input
							className={`${controlClass} ${p.costCapError ? "border-(--color-danger)" : ""} font-mono`}
							value={d.costCap}
							onChange={(e) => p.onCostCap(e.target.value)}
							placeholder="unset"
							inputMode="decimal"
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
					<Field label="Timeout per child" hint="NO PER-RUN TIMEOUT API YET">
						<select className={`${controlClass} opacity-60`} disabled value="">
							<option value="">—</option>
						</select>
					</Field>
				</div>
			</Section>
		</MobileCard>
	);
}

function IntentSection(p: SectionProps) {
	const d = p.draft;
	return (
		<MobileCard title="Intent">
			<Section
				title="Intent"
				description="The prompt each child run receives, with {seed_id} substituted per child."
				divider="none"
			>
				<div className="flex flex-col gap-[5px]">
					<span className={labelClass}>Prompt template</span>
					<textarea
						className={cn(controlClass, "min-h-[64px] resize-y py-2 sm:leading-[17px]")}
						value={d.promptTemplate}
						onChange={(e) => p.onPrompt(e.target.value)}
						placeholder="work on sd {seed_id}"
						disabled={!p.hasSeeds}
					/>
					<p className={hintClass}>
						{"{seed_id}"} IS SUBSTITUTED PER CHILD · PROJECT CONTEXT APPENDED AT DISPATCH
					</p>
				</div>
			</Section>
		</MobileCard>
	);
}

const footerButtonClass = cn(
	responsiveFooterButton,
	"flex h-11 items-center justify-center rounded-(--radius-sm) px-[11px] text-[11px] font-medium leading-[14px] disabled:opacity-50 sm:h-[31px] sm:justify-start",
);

function Footer(p: SectionProps) {
	return (
		<>
			<div className={cn(responsiveFooterActions, "px-0 py-[12px] sm:items-center md:px-[15px]")}>
				<p className={cn(hintClass, "hidden md:block md:flex-1")}>
					Dispatch writes the plan-run record before the first child is admitted.
				</p>
				<button
					type="button"
					onClick={p.onCancel}
					disabled={p.pending}
					className={cn(
						footerButtonClass,
						"hidden border border-(--color-border-strong) bg-(--color-surface) text-(--color-text-2) hover:bg-(--color-surface-hover) md:flex",
					)}
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={!p.canSubmit}
					className={cn(footerButtonClass, "bg-(--color-primary) text-(--color-primary-ink)")}
				>
					{p.pending ? "Dispatching…" : "Dispatch plan"}
				</button>
			</div>
			{p.submitError ? (
				<p className="px-3.5 py-2 font-mono text-[10px] leading-3 text-(--color-danger) md:border-t md:border-(--color-border) md:px-[15px]">
					{p.submitError}
				</p>
			) : null}
		</>
	);
}
