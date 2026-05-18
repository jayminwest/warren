import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { agentsApi, ApiError, plotsApi, projectsApi } from "@/api/client.ts";
import {
	ATTACHMENT_TYPES,
	type AttachmentType,
	type PlotAttachment,
	type PlotEnvelope,
	type PlotEvent,
} from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";

/**
 * /plots/:id — three-panel Plot detail page (warren-bdbf, pl-9d6a step 13).
 *
 * Layout:
 *   - Header: name + status badge + project link.
 *   - IntentPanel  (left)   — editable goal/non_goals/constraints/success_criteria
 *                             via POST /plots/:id/intent; disabled when status
 *                             is done/archived (server also rejects with 409).
 *   - SubstratePanel (right)— attachments grouped by role + Add/Detach dialog.
 *   - ActivityFeed  (full)  — event_log timeline; collapses runs of 3+
 *                             same-kind same-actor events into a fold.
 *
 * Polling: tanstack-query with staleTime + refetchInterval at 5s
 * (mx-268674 pattern). No live event stream yet — that's deferred per
 * SPEC §11.O.Plot.UI (pl-2047 risk #6).
 *
 * Out of scope here (separate steps in pl-9d6a):
 *   - Status transition button group (warren-6336 / step 16).
 *   - Inline question-answer card (warren-3c3e / step 15).
 *
 * Run-plan button (warren-5d94 / step 14): rendered on each sd_plan
 * attachment row in SubstratePanel; opens a confirm dialog and POSTs
 * `/plan-runs` with the auto-filled plot_id.
 */
export function PlotDetailPage() {
	const { id } = useParams<{ id: string }>();
	const plotId = id ?? "";

	const query = useQuery({
		queryKey: ["plot", plotId],
		queryFn: ({ signal }) => plotsApi.get(plotId, signal),
		enabled: plotId.length > 0,
		refetchInterval: 5_000,
		staleTime: 5_000,
	});

	if (plotId.length === 0) {
		return <p className="text-sm text-(--color-destructive)">Missing plot id in URL.</p>;
	}
	if (query.isLoading) {
		return <p className="text-sm text-(--color-muted-foreground)">Loading…</p>;
	}
	if (query.isError || query.data === undefined) {
		return (
			<p className="text-sm text-(--color-destructive)">
				{query.error instanceof Error ? query.error.message : "Failed to load plot."}
			</p>
		);
	}

	const plot = query.data;
	const frozen = plot.status === "done" || plot.status === "archived";

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<div className="flex items-baseline gap-3">
						<h1 className="text-2xl font-semibold tracking-tight">{plot.name}</h1>
						<span className="rounded-full border px-2 py-0.5 text-xs">
							{plot.status}
						</span>
					</div>
					<div className="font-mono text-xs text-(--color-muted-foreground)">
						{plot.id} · project{" "}
						<Link
							to={`/projects/${encodeURIComponent(plot.project_id)}`}
							className="underline-offset-2 hover:underline"
						>
							{plot.project_id}
						</Link>
					</div>
				</div>
			</header>

			<div className="grid gap-6 lg:grid-cols-2">
				<IntentPanel plot={plot} frozen={frozen} />
				<SubstratePanel plot={plot} />
			</div>

			<ActivityFeed events={plot.event_log} />
		</div>
	);
}

/* ----------------------------------------------------------------------- */
/* IntentPanel                                                              */
/* ----------------------------------------------------------------------- */

interface IntentDraft {
	goal: string;
	non_goals: string;
	constraints: string;
	success_criteria: string;
}

function intentToDraft(p: PlotEnvelope): IntentDraft {
	return {
		goal: p.intent.goal,
		non_goals: p.intent.non_goals.join("\n"),
		constraints: p.intent.constraints.join("\n"),
		success_criteria: p.intent.success_criteria.join("\n"),
	};
}

function splitLines(s: string): string[] {
	return s
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function IntentPanel({ plot, frozen }: { plot: PlotEnvelope; frozen: boolean }) {
	const qc = useQueryClient();
	const [draft, setDraft] = useState<IntentDraft>(() => intentToDraft(plot));
	const [dirty, setDirty] = useState(false);

	// Reconcile draft from server on refetch when the user has no
	// pending edits. Preserve the in-flight draft on dirty so a 5s poll
	// doesn't blow away the user's typing (draft-restore-on-failure
	// pattern from the issue).
	useEffect(() => {
		if (!dirty) setDraft(intentToDraft(plot));
	}, [plot, dirty]);

	const mutation = useMutation({
		mutationFn: () =>
			plotsApi.editIntent(plot.id, {
				goal: draft.goal,
				non_goals: splitLines(draft.non_goals),
				constraints: splitLines(draft.constraints),
				success_criteria: splitLines(draft.success_criteria),
			}),
		onSuccess: (envelope) => {
			qc.setQueryData(["plot", plot.id], envelope);
			qc.invalidateQueries({ queryKey: ["plots"] });
			setDirty(false);
			// Draft will resync via the useEffect above on next render.
		},
		// Draft-restore on failure: do nothing — `draft` already holds
		// the user's text, and `dirty` stays true so polling won't
		// clobber it.
	});

	const update = (key: keyof IntentDraft, value: string): void => {
		setDraft((d) => ({ ...d, [key]: value }));
		setDirty(true);
	};

	const reset = (): void => {
		setDraft(intentToDraft(plot));
		setDirty(false);
		mutation.reset();
	};

	const submit = (e: React.FormEvent): void => {
		e.preventDefault();
		mutation.mutate();
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Intent</CardTitle>
			</CardHeader>
			<CardContent>
				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="intent-goal">Goal</Label>
						<Textarea
							id="intent-goal"
							rows={3}
							value={draft.goal}
							onChange={(e) => update("goal", e.target.value)}
							disabled={frozen || mutation.isPending}
							placeholder="One paragraph describing what this Plot is for…"
						/>
					</div>
					<IntentListField
						id="intent-non_goals"
						label="Non-goals"
						value={draft.non_goals}
						onChange={(v) => update("non_goals", v)}
						disabled={frozen || mutation.isPending}
					/>
					<IntentListField
						id="intent-constraints"
						label="Constraints"
						value={draft.constraints}
						onChange={(v) => update("constraints", v)}
						disabled={frozen || mutation.isPending}
					/>
					<IntentListField
						id="intent-success_criteria"
						label="Success criteria"
						value={draft.success_criteria}
						onChange={(v) => update("success_criteria", v)}
						disabled={frozen || mutation.isPending}
					/>

					{frozen ? (
						<p className="text-xs text-(--color-muted-foreground)">
							Intent is frozen — status <code>{plot.status}</code> does not
							accept edits per SPEC §6.
						</p>
					) : null}

					{mutation.isError ? (
						<p className="text-sm text-(--color-destructive)">
							{mutation.error instanceof Error
								? mutation.error.message
								: String(mutation.error)}
						</p>
					) : null}

					<div className="flex items-center justify-end gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={reset}
							disabled={!dirty || mutation.isPending}
						>
							Reset
						</Button>
						<Button type="submit" disabled={!dirty || frozen || mutation.isPending}>
							{mutation.isPending ? "Saving…" : "Save"}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

function IntentListField({
	id,
	label,
	value,
	onChange,
	disabled,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (next: string) => void;
	disabled: boolean;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				id={id}
				rows={3}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
				placeholder="One item per line"
			/>
			<p className="text-xs text-(--color-muted-foreground)">One item per line.</p>
		</div>
	);
}

/* ----------------------------------------------------------------------- */
/* SubstratePanel                                                           */
/* ----------------------------------------------------------------------- */

function SubstratePanel({ plot }: { plot: PlotEnvelope }) {
	const [dialogOpen, setDialogOpen] = useState(false);

	const grouped = useMemo(() => groupAttachmentsByRole(plot.attachments), [plot.attachments]);

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0">
				<CardTitle>Substrate</CardTitle>
				<Button size="sm" onClick={() => setDialogOpen(true)}>
					Add attachment
				</Button>
			</CardHeader>
			<CardContent>
				{plot.attachments.length === 0 ? (
					<p className="text-sm text-(--color-muted-foreground)">
						No attachments yet.
					</p>
				) : (
					<div className="space-y-4">
						{grouped.map(([role, items]) => (
							<div key={role} className="space-y-1">
								<div className="text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
									{role || "(no role)"}
								</div>
								<ul className="divide-y rounded-md border">
									{items.map((a) => (
										<AttachmentRow
											key={a.id}
											plotId={plot.id}
											projectId={plot.project_id}
											attachment={a}
										/>
									))}
								</ul>
							</div>
						))}
					</div>
				)}
			</CardContent>

			<AddAttachmentDialog
				plotId={plot.id}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
			/>
		</Card>
	);
}

function groupAttachmentsByRole(
	attachments: readonly PlotAttachment[],
): [string, PlotAttachment[]][] {
	const map = new Map<string, PlotAttachment[]>();
	for (const a of attachments) {
		const arr = map.get(a.role);
		if (arr === undefined) map.set(a.role, [a]);
		else arr.push(a);
	}
	return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * sd_plan detection (warren-5d94). `@os-eco/plot-cli` v0.3 doesn't
 * carry a dedicated `sd_plan` AttachmentType, so the convention here
 * is: a `seeds_issue` attachment whose `ref` is a seeds plan id
 * (`pl-*`). Update this predicate when plot-cli grows a first-class
 * `seeds_plan` kind — the rest of the dialog plumbing stays put.
 */
function isSdPlanAttachment(a: PlotAttachment): boolean {
	return a.type === "seeds_issue" && /^pl-/i.test(a.ref);
}

function AttachmentRow({
	plotId,
	projectId,
	attachment,
}: {
	plotId: string;
	projectId: string;
	attachment: PlotAttachment;
}) {
	const qc = useQueryClient();
	const detach = useMutation({
		mutationFn: () => plotsApi.detach(plotId, attachment.ref),
		onSuccess: (resp) => {
			qc.setQueryData(["plot", plotId], resp.envelope);
			qc.invalidateQueries({ queryKey: ["plots"] });
		},
	});
	return (
		<li className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
			<div className="min-w-0 space-y-0.5">
				<div className="flex items-baseline gap-2">
					<span className="rounded border px-1.5 py-0.5 font-mono text-xs">
						{attachment.type}
					</span>
					<span className="truncate font-mono">{attachment.ref}</span>
				</div>
				<div className="text-xs text-(--color-muted-foreground)">
					{attachment.added_by} · {relativeTime(attachment.added_at)}
				</div>
				{detach.isError ? (
					<p className="text-xs text-(--color-destructive)">
						{detach.error instanceof Error
							? detach.error.message
							: String(detach.error)}
					</p>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{isSdPlanAttachment(attachment) ? (
					<RunPlanButton
						plotId={plotId}
						projectId={projectId}
						planRef={attachment.ref}
					/>
				) : null}
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => detach.mutate()}
					disabled={detach.isPending}
				>
					{detach.isPending ? "…" : "Detach"}
				</Button>
			</div>
		</li>
	);
}

function AddAttachmentDialog({
	plotId,
	open,
	onOpenChange,
}: {
	plotId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const qc = useQueryClient();
	const [kind, setKind] = useState<AttachmentType>("seeds_issue");
	const [ref, setRef] = useState("");
	const [role, setRole] = useState("");

	const attach = useMutation({
		mutationFn: () => {
			const trimmedRole = role.trim();
			return plotsApi.attach(plotId, {
				kind,
				ref: ref.trim(),
				...(trimmedRole.length > 0 ? { role: trimmedRole } : {}),
			});
		},
		onSuccess: (resp) => {
			qc.setQueryData(["plot", plotId], resp.envelope);
			qc.invalidateQueries({ queryKey: ["plots"] });
			onOpenChange(false);
			setKind("seeds_issue");
			setRef("");
			setRole("");
		},
	});

	const submittable = ref.trim().length > 0 && !attach.isPending;

	const submit = (e: React.FormEvent): void => {
		e.preventDefault();
		if (!submittable) return;
		attach.mutate();
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) attach.reset();
				onOpenChange(next);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add attachment</DialogTitle>
					<DialogDescription>
						Attach an external reference (issue, mulch record, run, PR, file…)
						to this Plot.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="attach-kind">Kind</Label>
						<select
							id="attach-kind"
							value={kind}
							onChange={(e) => setKind(e.target.value as AttachmentType)}
							className="flex h-9 w-full rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)"
						>
							{ATTACHMENT_TYPES.map((t) => (
								<option key={t} value={t}>
									{t}
								</option>
							))}
						</select>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="attach-ref">Ref</Label>
						<Input
							id="attach-ref"
							required
							value={ref}
							onChange={(e) => setRef(e.target.value)}
							placeholder={refPlaceholder(kind)}
							autoComplete="off"
							spellCheck={false}
						/>
						<p className="text-xs text-(--color-muted-foreground)">
							{refHint(kind)}
						</p>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="attach-role">Role (optional)</Label>
						<Input
							id="attach-role"
							value={role}
							onChange={(e) => setRole(e.target.value)}
							placeholder="tracks · implements · informs · discussion · reference"
							autoComplete="off"
							spellCheck={false}
						/>
					</div>

					{attach.isError ? (
						<p className="text-sm text-(--color-destructive)">
							{attach.error instanceof Error
								? attach.error.message
								: String(attach.error)}
						</p>
					) : null}

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={attach.isPending}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={!submittable}>
							{attach.isPending ? "Attaching…" : "Attach"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function refPlaceholder(kind: AttachmentType): string {
	switch (kind) {
		case "seeds_issue":
			return "warren-bdbf";
		case "mulch_record":
			return "mx-b97599";
		case "agent_run":
			return "run-abc123";
		case "gh_pr":
			return "owner/repo#123";
		case "gh_issue":
			return "owner/repo#456";
		case "file":
			return "src/some/path.ts";
	}
}

function refHint(kind: AttachmentType): string {
	switch (kind) {
		case "seeds_issue":
			return "Seeds issue id, e.g. project-bdbf.";
		case "mulch_record":
			return "Mulch record id, e.g. mx-b97599.";
		case "agent_run":
			return "Warren run id starting with run-.";
		case "gh_pr":
		case "gh_issue":
			return "Free-form (URL or owner/repo#N).";
		case "file":
			return "Free-form path.";
	}
}

/* ----------------------------------------------------------------------- */
/* RunPlanButton (warren-5d94)                                              */
/* ----------------------------------------------------------------------- */

const DEFAULT_PROMPT_TEMPLATE = "work on sd {seed_id}";

/**
 * Per-attachment "Run plan" action. Visible only when the row is an
 * sd_plan attachment (see isSdPlanAttachment). Clicking opens a
 * confirm dialog showing the read-only triple (plan ref, project,
 * auto-filled plot_id) and the resolved agent + default prompt
 * template; confirm POSTs to `/plan-runs` via `plotsApi.dispatchPlanRun`.
 * On success the user is routed to `/plan-runs/:id`, which closes the
 * loop back to this Plot via PlanRunDetail's existing back-link
 * (mx-757be9 / warren-37fd).
 */
function RunPlanButton({
	plotId,
	projectId,
	planRef,
}: {
	plotId: string;
	projectId: string;
	planRef: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button type="button" size="sm" onClick={() => setOpen(true)}>
				Run plan
			</Button>
			{open ? (
				<RunPlanDialog
					plotId={plotId}
					projectId={projectId}
					planRef={planRef}
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	);
}

function RunPlanDialog({
	plotId,
	projectId,
	planRef,
	onOpenChange,
}: {
	plotId: string;
	projectId: string;
	planRef: string;
	onOpenChange: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const qc = useQueryClient();

	// Resolve project defaults + agent registry to fill in the dispatch
	// inputs the user can't see on PlotDetail. This mirrors NewPlanRun's
	// defaults flow (mx-4c064b / mx-be04a6) so dispatching from a Plot
	// uses the same auto-filled provider/model/agent the dedicated
	// NewPlanRun page would have used.
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const warrenConfig = useQuery({
		queryKey: ["projects", projectId, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(projectId, signal),
	});
	const agents = useQuery({
		queryKey: ["agents", { projectId }],
		queryFn: ({ signal }) => agentsApi.list({ projectId }, signal),
	});

	const project = projects.data?.projects.find((p) => p.id === projectId);
	const defaults = warrenConfig.data?.defaults ?? null;
	const defaultRole = defaults?.defaultRole;
	const registered = agents.data?.agents ?? [];
	const defaultRoleRegistered =
		defaultRole !== undefined && registered.some((a) => a.name === defaultRole);
	const resolvedAgent = defaultRoleRegistered ? (defaultRole as string) : null;

	const dispatch = useMutation({
		mutationFn: () => {
			if (resolvedAgent === null) {
				throw new Error(
					"No default agent resolved — set `defaults.defaultRole` in `.warren/defaults.yaml` and register the agent.",
				);
			}
			const provider = defaults?.defaultProvider;
			const model = defaults?.defaultModel;
			return plotsApi.dispatchPlanRun({
				project: projectId,
				planId: planRef,
				agent: resolvedAgent,
				promptTemplate: DEFAULT_PROMPT_TEMPLATE,
				plotId,
				...(provider !== undefined && provider.length > 0
					? { providerOverride: provider }
					: {}),
				...(model !== undefined && model.length > 0
					? { modelOverride: model }
					: {}),
			});
		},
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["plan-runs"] });
			qc.invalidateQueries({ queryKey: ["plot", plotId] });
			navigate(`/plan-runs/${encodeURIComponent(data.planRun.id)}`);
		},
	});

	const loading = projects.isLoading || warrenConfig.isLoading || agents.isLoading;
	const hasSeeds = project?.hasSeeds ?? false;
	const readyToDispatch =
		!loading && hasSeeds && resolvedAgent !== null && !dispatch.isPending;

	const errorMessage = ((): string | null => {
		if (dispatch.error === null || dispatch.error === undefined) return null;
		if (dispatch.error instanceof ApiError) {
			return `${dispatch.error.message} (${dispatch.error.code})`;
		}
		return dispatch.error instanceof Error
			? dispatch.error.message
			: String(dispatch.error);
	})();

	return (
		<Dialog
			open={true}
			onOpenChange={(next) => {
				if (!next) dispatch.reset();
				onOpenChange(next);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Run plan</DialogTitle>
					<DialogDescription>
						Dispatch a plan run bound to this Plot. Each child seed in
						the plan is dispatched as its own warren run; the Plot
						auto-transitions to <code className="font-mono">done</code>{" "}
						when every child merges.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 text-sm">
					<ReadOnlyField label="Plan" value={planRef} />
					<ReadOnlyField
						label="Project"
						value={project?.gitUrl ?? projectId}
						hint={project?.gitUrl !== undefined ? projectId : undefined}
					/>
					<ReadOnlyField label="Plot" value={plotId} />
					<ReadOnlyField
						label="Agent"
						value={
							loading
								? "resolving…"
								: (resolvedAgent ?? "(no default agent set)")
						}
					/>
					<ReadOnlyField
						label="Prompt template"
						value={DEFAULT_PROMPT_TEMPLATE}
						hint="{seed_id} is substituted per child."
					/>
				</div>

				{!loading && !hasSeeds ? (
					<p className="text-sm text-(--color-destructive)">
						Plan runs require <code className="font-mono">.seeds/</code>{" "}
						at the project root. This project has none — add one and
						refresh.
					</p>
				) : null}
				{!loading && hasSeeds && resolvedAgent === null ? (
					<p className="text-sm text-(--color-destructive)">
						No default agent resolved. Set{" "}
						<code className="font-mono">defaults.defaultRole</code> in{" "}
						<code className="font-mono">.warren/defaults.yaml</code> and
						register the agent, or dispatch from{" "}
						<Link
							to="/plan-runs/new"
							className="underline-offset-2 hover:underline"
						>
							/plan-runs/new
						</Link>{" "}
						with the agent picker.
					</p>
				) : null}
				{errorMessage !== null ? (
					<p className="text-sm text-(--color-destructive)">{errorMessage}</p>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={dispatch.isPending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={!readyToDispatch}
						onClick={() => dispatch.mutate()}
					>
						{dispatch.isPending ? "Dispatching…" : "Dispatch"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ReadOnlyField({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint?: string;
}) {
	return (
		<div className="space-y-0.5">
			<div className="text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
				{label}
			</div>
			<div className="break-all font-mono text-sm">{value}</div>
			{hint !== undefined ? (
				<div className="text-xs text-(--color-muted-foreground)">{hint}</div>
			) : null}
		</div>
	);
}

/* ----------------------------------------------------------------------- */
/* ActivityFeed                                                             */
/* ----------------------------------------------------------------------- */

interface Cluster {
	kind: "single" | "fold";
	events: PlotEvent[]; // 1 for single, 3+ for fold
}

/**
 * Collapse chains of 3+ consecutive same-kind same-actor events into a
 * single fold. Length-2 chains stay expanded — folding starts at three
 * per the seed contract.
 */
function clusterEvents(events: readonly PlotEvent[]): Cluster[] {
	const out: Cluster[] = [];
	let i = 0;
	while (i < events.length) {
		const head = events[i];
		if (head === undefined) {
			i += 1;
			continue;
		}
		let j = i + 1;
		while (j < events.length) {
			const next = events[j];
			if (next === undefined) break;
			if (next.type !== head.type || next.actor !== head.actor) break;
			j += 1;
		}
		const runLen = j - i;
		if (runLen >= 3) {
			out.push({ kind: "fold", events: events.slice(i, j) });
		} else {
			for (let k = i; k < j; k += 1) {
				const e = events[k];
				if (e !== undefined) out.push({ kind: "single", events: [e] });
			}
		}
		i = j;
	}
	return out;
}

function ActivityFeed({ events }: { events: readonly PlotEvent[] }) {
	const clusters = useMemo(() => clusterEvents(events), [events]);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Activity</CardTitle>
			</CardHeader>
			<CardContent>
				{clusters.length === 0 ? (
					<p className="text-sm text-(--color-muted-foreground)">No events yet.</p>
				) : (
					<ol className="space-y-1">
						{clusters.map((c, idx) =>
							c.kind === "fold" ? (
								<FoldedCluster
									// biome-ignore lint/suspicious/noArrayIndexKey: clusters
									// are derived deterministically from a stably-sorted
									// event_log; index is the stable cluster id within
									// this render.
									key={`fold-${idx}`}
									events={c.events}
								/>
							) : (
								<EventLine
									// biome-ignore lint/suspicious/noArrayIndexKey: see
									// above — singles also key on their cluster index.
									key={`evt-${idx}`}
									event={c.events[0] as PlotEvent}
								/>
							),
						)}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}

function FoldedCluster({ events }: { events: PlotEvent[] }) {
	const [open, setOpen] = useState(false);
	const head = events[0] as PlotEvent;
	const tail = events[events.length - 1] as PlotEvent;
	if (open) {
		return (
			<>
				<li>
					<button
						type="button"
						onClick={() => setOpen(false)}
						className="text-xs text-(--color-muted-foreground) underline-offset-2 hover:underline"
					>
						Collapse {events.length} {head.type} events
					</button>
				</li>
				{events.map((e) => (
					<EventLine key={`${e.at}-${e.type}`} event={e} />
				))}
			</>
		);
	}
	return (
		<li className="flex items-baseline gap-3 rounded-md border border-dashed px-3 py-2 text-sm">
			<ActorSlot actor={head.actor} />
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="min-w-0 flex-1 text-left text-(--color-muted-foreground) underline-offset-2 hover:underline"
			>
				{events.length} {head.type} events
			</button>
			<span className="shrink-0 font-mono text-xs text-(--color-muted-foreground)">
				{relativeTime(tail.at)}
			</span>
		</li>
	);
}

/**
 * One event row. Borrowed shape from RunDetail's EventLine (mx-b97599):
 * a `<details>` block where `<summary>` is the always-visible one-liner
 * and the expanded body shows the raw payload. The actor slot lives
 * on the left of the summary so eyes can scan a stable column.
 */
function EventLine({ event }: { event: PlotEvent }) {
	const summary = summarizePlotEvent(event);
	const expanded = JSON.stringify(event.data, null, 2);
	return (
		<li>
			<details className="group">
				<summary className="flex cursor-pointer items-baseline gap-3 rounded-md px-2 py-1 text-sm select-none hover:bg-(--color-accent) [&::-webkit-details-marker]:hidden">
					<ActorSlot actor={event.actor} />
					<span className="shrink-0 font-medium">{event.type}</span>
					<span className="min-w-0 flex-1 truncate text-(--color-muted-foreground) group-open:hidden">
						{summary}
					</span>
					<span className="shrink-0 font-mono text-xs text-(--color-muted-foreground)">
						{relativeTime(event.at)}
					</span>
				</summary>
				<div className="ml-[11rem] mt-1 mb-2 space-y-1">
					<div className="text-xs text-(--color-muted-foreground)">
						{formatTimestamp(event.at)}
					</div>
					<pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded bg-(--color-card) p-2 text-xs">
						{expanded}
					</pre>
				</div>
			</details>
		</li>
	);
}

function ActorSlot({ actor }: { actor: string }) {
	return (
		<span
			className="w-40 shrink-0 truncate font-mono text-xs text-(--color-muted-foreground)"
			title={actor}
		>
			{actor}
		</span>
	);
}

function summarizePlotEvent(event: PlotEvent): string {
	const d = event.data ?? {};
	switch (event.type) {
		case "plot_created":
			return readString(d.name) ?? "";
		case "intent_edited": {
			const field = readString(d.field);
			return field !== null ? `field=${field}` : "";
		}
		case "status_changed": {
			const from = readString(d.from);
			const to = readString(d.to);
			return from !== null && to !== null ? `${from} → ${to}` : "";
		}
		case "attachment_added": {
			const type = readString(d.type);
			const ref = readString(d.ref);
			return type !== null && ref !== null ? `${type} ${ref}` : "";
		}
		case "attachment_removed":
			return readString(d.id) ?? "";
		case "run_dispatched":
			return readString(d.run_id) ?? "";
		case "plan_run_dispatched":
			return readString(d.plan_run_id) ?? "";
		case "decision_made":
			return readString(d.summary) ?? "";
		case "question_posed":
		case "question_answered":
		case "note":
			return readString(d.text) ?? "";
		case "artifact_produced": {
			const type = readString(d.type);
			const ref = readString(d.ref);
			return type !== null && ref !== null ? `${type} ${ref}` : (ref ?? "");
		}
		default:
			return "";
	}
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
