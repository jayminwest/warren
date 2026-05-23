import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { agentsApi, ApiError, plotsApi, projectsApi, runsApi } from "@/api/client.ts";
import {
	ATTACHMENT_TYPES,
	type AttachmentType,
	type MergePlotPrOutcome,
	type PausedRunInfo,
	type PlotAttachment,
	type PlotEnvelope,
	type PlotEvent,
	type PlotStatus,
} from "@/api/types.ts";
import { Chat } from "@/components/Chat.tsx";
import { PlotStatusBadge } from "@/components/PlotStatusBadge.tsx";
import { StateBadge } from "@/components/StateBadge.tsx";
import { RefreshProjectsCTA } from "@/components/RefreshProjectsCTA.tsx";
import type { NewRunRouteState } from "@/pages/NewRun.tsx";
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
 * Status transition control (warren-6336 / pl-9d6a step 16): the
 * header renders `PlotStatusBadge` above a `StatusTransitionControl`
 * button group that surfaces only the legally-reachable next statuses
 * per SPEC §6.5 (matrix mirrored from `src/plots/status-changer.ts`).
 * Click POSTs `/plots/:id/status` via `plotsApi.changeStatus` and
 * optimistically swaps the cached envelope's status + splices the
 * returned `status_changed` event into the activity feed; failure
 * surfaces inline below the buttons.
 *
 * Inline question-answer card (warren-3c3e / pl-9d6a step 15):
 * `question_posed` events without a matching `question_answered`
 * (joined on `question_id === question_posed.at`) render an inline
 * answer card with a textarea + Submit; submit POSTs to
 * `/plots/:id/questions/:event_id/answer` via `plotsApi.answerQuestion`
 * and optimistically splices the returned event into the cached plot
 * envelope. Closed questions render the answer text collapsed under
 * the question row, no card.
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
		const message =
			query.error instanceof Error ? query.error.message : "Failed to load plot.";
		// warren-bb22: 404 here usually means the Plot was committed in a
		// project clone but the project hasn't been refreshed since
		// (detectProjectFeatures only flips hasPlot during refresh — see
		// mx-62ef33). Surface a refresh-all CTA so the user can recover
		// inline without bouncing to /projects.
		return (
			<Card>
				<CardContent className="space-y-3 p-4 text-sm">
					<p className="text-(--color-destructive)">{message}</p>
					<p className="text-(--color-muted-foreground)">
						If you just committed this Plot in a project clone, refresh
						projects so warren rediscovers it.
					</p>
					<RefreshProjectsCTA />
				</CardContent>
			</Card>
		);
	}

	const plot = query.data;
	const frozen = plot.status === "done" || plot.status === "archived";

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">{plot.name}</h1>
					<div className="font-mono text-xs text-(--color-muted-foreground)">
						{plot.id} · project{" "}
						<Link
							to={`/projects/${encodeURIComponent(plot.project_id)}`}
							className="underline-offset-2 hover:underline"
						>
							{plot.project_id}
						</Link>
						{" · "}
						<Link
							to={`/plots/${encodeURIComponent(plot.id)}/summary`}
							className="underline-offset-2 hover:underline"
						>
							view summary
						</Link>
					</div>
				</div>
				<StatusTransitionControl plot={plot} />
			</header>

			<div className="grid gap-6 lg:grid-cols-2">
				<IntentPanel plot={plot} frozen={frozen} />
				<SubstratePanel plot={plot} />
			</div>

			<InteractivePanel plot={plot} frozen={frozen} />

			<ActivityFeed
				plotId={plot.id}
				events={plot.event_log}
				pausedRuns={plot.paused_runs}
			/>
		</div>
	);
}

/* ----------------------------------------------------------------------- */
/* StatusTransitionControl (warren-6336)                                    */
/* ----------------------------------------------------------------------- */

/**
 * SPEC §6.5 transition matrix mirrored from
 * `src/plots/status-changer.ts` `STATUS_TRANSITIONS`. Kept as a UI-side
 * constant so the button group can render before the request reaches
 * the server; the server re-validates authoritatively. If the matrix
 * ever drifts, the server's `PlotIllegalStatusTransitionError`
 * surfaces inline below the buttons so the mistake is loud rather
 * than silent.
 */
const NEXT_STATUSES: Readonly<Record<PlotStatus, readonly PlotStatus[]>> = {
	drafting: ["ready", "archived"],
	ready: ["active", "archived"],
	active: ["done", "archived"],
	done: ["archived"],
	archived: [],
};

function StatusTransitionControl({ plot }: { plot: PlotEnvelope }) {
	const qc = useQueryClient();
	const nexts = NEXT_STATUSES[plot.status];

	const mutation = useMutation({
		mutationFn: (next: PlotStatus) => plotsApi.changeStatus(plot.id, { next }),
		onMutate: async (next) => {
			// Optimistic: cancel in-flight refetches and patch the cached
			// envelope so the badge + button group flip immediately. The
			// server-returned event splices into event_log onSuccess; if the
			// request fails we roll back below.
			await qc.cancelQueries({ queryKey: ["plot", plot.id] });
			const prev = qc.getQueryData<PlotEnvelope>(["plot", plot.id]);
			if (prev !== undefined) {
				qc.setQueryData<PlotEnvelope>(["plot", plot.id], {
					...prev,
					status: next,
				});
			}
			return { prev };
		},
		onError: (_err, _next, ctx) => {
			if (ctx?.prev !== undefined) {
				qc.setQueryData(["plot", plot.id], ctx.prev);
			}
		},
		onSuccess: (resp) => {
			qc.setQueryData<PlotEnvelope>(["plot", plot.id], (prev) => {
				if (prev === undefined) return prev;
				const hasEvent = prev.event_log.some((e) => e.at === resp.event.at);
				return {
					...prev,
					status: resp.summary.status,
					event_log: hasEvent ? prev.event_log : [...prev.event_log, resp.event],
				};
			});
			qc.invalidateQueries({ queryKey: ["plots"] });
			qc.invalidateQueries({ queryKey: ["plot", plot.id] });
		},
	});

	const errorMessage = ((): string | null => {
		if (!mutation.isError) return null;
		if (mutation.error instanceof ApiError) {
			return `${mutation.error.message} (${mutation.error.code})`;
		}
		return mutation.error instanceof Error
			? mutation.error.message
			: String(mutation.error);
	})();

	return (
		<div className="flex flex-col items-end gap-2">
			<PlotStatusBadge status={plot.status} />
			{nexts.length === 0 ? (
				<p className="text-xs text-(--color-muted-foreground)">
					Terminal status — no further transitions.
				</p>
			) : (
				<div className="flex flex-wrap items-center justify-end gap-2">
					{nexts.map((next) => (
						<Button
							key={next}
							type="button"
							size="sm"
							variant={next === "archived" ? "outline" : "default"}
							disabled={mutation.isPending}
							onClick={() => mutation.mutate(next)}
						>
							{mutation.isPending && mutation.variables === next
								? `→ ${next}…`
								: `→ ${next}`}
						</Button>
					))}
				</div>
			)}
			{errorMessage !== null ? (
				<p className="max-w-xs text-right text-xs text-(--color-destructive)">
					{errorMessage}
				</p>
			) : null}
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
	const batchTargets = useMemo(
		() => plot.attachments.filter(isBatchDispatchTarget),
		[plot.attachments],
	);

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0">
				<CardTitle>Substrate</CardTitle>
				<div className="flex items-center gap-2">
					{batchTargets.length > 0 ? (
						<DispatchAsPlanRunButton
							plotId={plot.id}
							projectId={plot.project_id}
							targets={batchTargets}
						/>
					) : null}
					{batchTargets.length > 0 ? (
						<BatchDispatchAllButton
							plotId={plot.id}
							projectId={plot.project_id}
							targets={batchTargets}
						/>
					) : null}
					<Button size="sm" onClick={() => setDialogOpen(true)}>
						Add attachment
					</Button>
				</div>
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
	const merge = useMutation({
		mutationFn: () => plotsApi.mergeAttachment(plotId, attachment.ref),
		onSuccess: (resp) => {
			qc.setQueryData(["plot", plotId], resp.envelope);
			qc.invalidateQueries({ queryKey: ["plots"] });
			if (resp.refresh_scheduled) {
				// Background clone refresh was scheduled — give the plot list
				// a nudge so `last_event_ts` / project row updates surface
				// on the next poll.
				qc.invalidateQueries({ queryKey: ["projects"] });
			}
		},
	});
	const mergeOutcome = merge.data?.merge;
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
				{merge.isError ? (
					<p className="text-xs text-(--color-destructive)">
						{merge.error instanceof Error
							? merge.error.message
							: String(merge.error)}
					</p>
				) : null}
				{mergeOutcome !== undefined ? (
					<MergeOutcomeBanner outcome={mergeOutcome} />
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{attachment.type === "gh_pr" ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => merge.mutate()}
						disabled={merge.isPending}
						title="Merge this PR via the GitHub REST API and refresh the project clone"
					>
						{merge.isPending ? "Merging…" : "Merge"}
					</Button>
				) : null}
				{isSdPlanAttachment(attachment) ? (
					<RunPlanButton
						plotId={plotId}
						projectId={projectId}
						planRef={attachment.ref}
					/>
				) : null}
				{attachment.type === "seeds_issue" ? (
					<RunSeedButton
						plotId={plotId}
						projectId={projectId}
						seedRef={attachment.ref}
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
/* DispatchAsPlanRunButton (warren-bce0 / pl-f404 step 4 / SPEC §11.Q)      */
/* ----------------------------------------------------------------------- */

/**
 * Synthesized plan-title preview shown in the confirm dialog. Mirrors
 * the server-side synthesizer's title (see src/plot-plan-runs/
 * synthesizer.ts) so the operator sees the exact name that will land in
 * `.seeds/plans.jsonl`.
 */
function synthesizedPlanTitle(plotId: string): string {
	return `Plot ${plotId} synthesized plan-run`;
}

/**
 * Per-Plot "Dispatch as plan-run" header action (warren-bce0 /
 * pl-f404 step 4). Recommended path over `BatchDispatchAllButton`
 * (warren-7c3f) once SPEC §11.Q ships: instead of N parallel `POST
 * /runs`, this synthesizes a seeds plan from the Plot's open
 * `seeds_issue` attachments and dispatches it through the §11.P
 * coordinator — one tracked PlanRun row, PR-merge-serial gating, and
 * the auto-`done` Plot transition inherited for free. Eligibility is
 * the same `isBatchDispatchTarget` filter the batch button uses; the
 * confirm dialog lists the candidates (server-side will further drop
 * any closed seeds at synthesis time).
 */
function DispatchAsPlanRunButton({
	plotId,
	projectId,
	targets,
}: {
	plotId: string;
	projectId: string;
	targets: readonly PlotAttachment[];
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button type="button" size="sm" onClick={() => setOpen(true)}>
				Dispatch as plan-run ({targets.length})
			</Button>
			{open ? (
				<DispatchAsPlanRunDialog
					plotId={plotId}
					projectId={projectId}
					targets={targets}
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	);
}

function DispatchAsPlanRunDialog({
	plotId,
	projectId,
	targets,
	onOpenChange,
}: {
	plotId: string;
	projectId: string;
	targets: readonly PlotAttachment[];
	onOpenChange: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const qc = useQueryClient();

	// Same defaults/agent resolution as RunPlanDialog (mx-4c064b /
	// mx-be04a6) so dispatching from a Plot uses the project's
	// configured agent + provider/model overrides without bouncing
	// through /plan-runs/new.
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
	const resolvedAgent =
		defaultRole !== undefined && registered.some((a) => a.name === defaultRole)
			? (defaultRole as string)
			: null;
	const template = defaults?.defaultPrompt ?? DEFAULT_PROMPT_TEMPLATE;

	const dispatch = useMutation({
		mutationFn: () => {
			if (resolvedAgent === null) {
				throw new Error(
					"No default agent resolved — set `defaults.defaultRole` in `.warren/defaults.yaml` and register the agent.",
				);
			}
			const provider = defaults?.defaultProvider;
			const model = defaults?.defaultModel;
			return plotsApi.dispatchSynthesizedPlanRun({
				plotId,
				projectId,
				agent: resolvedAgent,
				promptTemplate: template,
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
					<DialogTitle>Dispatch as plan-run</DialogTitle>
					<DialogDescription>
						Synthesize a seeds plan from this Plot's open{" "}
						<code className="font-mono">seeds_issue</code> attachments and
						dispatch it as a single plan-run. Children run serially, gated on
						each previous PR merging; the Plot auto-transitions to{" "}
						<code className="font-mono">done</code> when the final child
						merges.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 text-sm">
					<ReadOnlyField label="Project" value={project?.gitUrl ?? projectId} hint={project?.gitUrl !== undefined ? projectId : undefined} />
					<ReadOnlyField label="Plot" value={plotId} />
					<ReadOnlyField
						label="Synthesized plan title"
						value={synthesizedPlanTitle(plotId)}
						hint="Mints a fresh throwaway parent seed on submit."
					/>
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
						value={template}
						hint="{seed_id} is substituted per child."
					/>
					<div className="space-y-1">
						<div className="text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
							Candidates ({targets.length})
						</div>
						<p className="text-xs text-(--color-muted-foreground)">
							seeds_issue attachments excluding sd_plan-shaped refs
							(<code className="font-mono">pl-*</code>, dispatched via the
							per-row Run plan button). Closed seeds are dropped server-side
							at synthesis time.
						</p>
						<ul className="max-h-40 overflow-auto divide-y rounded-md border">
							{targets.map((t) => (
								<li
									key={t.id}
									className="px-3 py-1.5 text-xs"
								>
									<span className="truncate font-mono">{t.ref}</span>
								</li>
							))}
						</ul>
					</div>
				</div>

				{!loading && !hasSeeds ? (
					<p className="text-sm text-(--color-destructive)">
						Plan-runs require <code className="font-mono">.seeds/</code> at
						the project root. This project has none — add one and refresh.
					</p>
				) : null}
				{!loading && hasSeeds && resolvedAgent === null ? (
					<p className="text-sm text-(--color-destructive)">
						No default agent resolved. Set{" "}
						<code className="font-mono">defaults.defaultRole</code> in{" "}
						<code className="font-mono">.warren/defaults.yaml</code> and
						register the agent before dispatching.
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

/* ----------------------------------------------------------------------- */
/* BatchDispatchAllButton (warren-7c3f / pl-5310 step 3)                    */
/* ----------------------------------------------------------------------- */

const DEFAULT_SEED_PROMPT_TEMPLATE = "work on sd {seed_id}";

/**
 * Inline banner that surfaces the GitHub merge outcome under a
 * `gh_pr` attachment row. Tuned for the V1.5 click-to-merge flow
 * (warren-8e39): success collapses to a one-liner, error states
 * (rate-limited, not-mergeable, missing token) show the relevant
 * detail so the operator knows what to do next.
 */
function MergeOutcomeBanner({ outcome }: { outcome: MergePlotPrOutcome }) {
	switch (outcome.kind) {
		case "merged":
			return (
				<p className="text-xs text-(--color-muted-foreground)">
					Merged · sha {outcome.sha.slice(0, 7)} · syncing clone…
				</p>
			);
		case "already_merged":
			return (
				<p className="text-xs text-(--color-muted-foreground)">
					Already merged · syncing clone…
				</p>
			);
		case "not_mergeable":
			return (
				<p className="text-xs text-(--color-destructive)">
					Cannot merge: {outcome.message}
				</p>
			);
		case "not_found":
			return (
				<p className="text-xs text-(--color-destructive)">
					PR not found on GitHub: {outcome.message}
				</p>
			);
		case "missing_token":
			return (
				<p className="text-xs text-(--color-destructive)">
					GITHUB_TOKEN unset on the warren server — set it to enable
					click-to-merge.
				</p>
			);
		case "rate_limited": {
			const reset = outcome.resetAt;
			return (
				<p className="text-xs text-(--color-destructive)">
					GitHub rate limit hit
					{reset !== null ? ` · resets ${relativeTime(reset)}` : ""} · try
					again shortly.
				</p>
			);
		}
		case "network":
			return (
				<p className="text-xs text-(--color-destructive)">
					Network error talking to GitHub: {outcome.message}
				</p>
			);
		case "http_error":
			return (
				<p className="text-xs text-(--color-destructive)">
					GitHub returned {outcome.status}: {outcome.message}
				</p>
			);
	}
}

/**
 * V1 batch-dispatch eligibility: a `seeds_issue` attachment whose ref
 * is NOT a seeds plan id. sd_plan-shaped attachments already have
 * their own per-row `Run plan` button (warren-5d94) and shouldn't be
 * dispatched as individual seed runs.
 *
 * Closed-seed filtering (warren-ea66 acceptance (d)) lives inside the
 * confirm dialog: each target's status is fetched via
 * `projectsApi.seedStatus` (warren-4015) at dialog-open time, and
 * closed seeds are marked `skipped` so they show up in the list but
 * are not dispatched. The button label still counts every eligible
 * attachment — the closed-seed count is small enough that two extra
 * shell-outs per dispatch (parallel) beat a status probe on every
 * Plot render.
 */
function isBatchDispatchTarget(a: PlotAttachment): boolean {
	return a.type === "seeds_issue" && !isSdPlanAttachment(a);
}

interface BatchDispatchOutcome {
	ref: string;
	status: "pending" | "dispatched" | "failed" | "skipped";
	runId?: string;
	error?: string;
	seedStatus?: string;
}

/**
 * Batch "Dispatch all attached seeds" header action on PlotDetail
 * (warren-7c3f / pl-5310 step 3). Reuses the same per-seed dispatch
 * primitive as `RunSeedButton` (warren-ff2a) — same agent/prompt
 * resolution from `.warren/defaults.yaml`, same `plotId` binding — but
 * fires N parallel `POST /runs` requests in one go instead of routing
 * the user through `/runs/new` per attachment.
 *
 * Scope (V1): parallel mode only. Serial-gated-on-PR-merge mode is
 * deferred to pl-5310 step 4 (Plot→synthesized plan→plan-run), which
 * inherits gating for free from the existing plan-run coordinator.
 * Adding a stop-gap serial queue inside warren now would build a code
 * path step 4 immediately deprecates (pl-5310 risk #4).
 *
 * Server-side wiring: each `POST /runs` with `plotId` emits a
 * `run_dispatched` event onto the Plot's event_log (SPEC §11.O), so
 * the activity feed picks all N up within one 5s poll tick — no extra
 * client work required.
 */
function BatchDispatchAllButton({
	plotId,
	projectId,
	targets,
}: {
	plotId: string;
	projectId: string;
	targets: readonly PlotAttachment[];
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
				Dispatch all ({targets.length})
			</Button>
			{open ? (
				<BatchDispatchDialog
					plotId={plotId}
					projectId={projectId}
					targets={targets}
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	);
}

function BatchDispatchDialog({
	plotId,
	projectId,
	targets,
	onOpenChange,
}: {
	plotId: string;
	projectId: string;
	targets: readonly PlotAttachment[];
	onOpenChange: (open: boolean) => void;
}) {
	const qc = useQueryClient();
	const warrenConfig = useQuery({
		queryKey: ["projects", projectId, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(projectId, signal),
	});
	const agents = useQuery({
		queryKey: ["agents", { projectId }],
		queryFn: ({ signal }) => agentsApi.list({ projectId }, signal),
	});
	// Probe each target's current seed status so closed seeds get filtered
	// out before dispatch (warren-4015 / warren-ea66 acceptance (d)). The
	// `GET /projects/:id/seeds/:seedId` round-trip is cheap (cached `sd
	// show` + filesystem read) and fans out in parallel across targets.
	// Surfacing failures as "unknown" rather than blocking keeps the
	// dialog usable when sd misbehaves on one ref.
	const seedStatuses = useQuery({
		queryKey: ["projects", projectId, "seed-statuses", targets.map((t) => t.ref)],
		queryFn: async ({ signal }) => {
			const entries = await Promise.all(
				targets.map(async (t) => {
					try {
						const resp = await projectsApi.seedStatus(projectId, t.ref, signal);
						return [t.ref, resp.status] as const;
					} catch {
						return [t.ref, "unknown"] as const;
					}
				}),
			);
			return Object.fromEntries(entries);
		},
	});

	const defaults = warrenConfig.data?.defaults ?? null;
	const defaultRole = defaults?.defaultRole;
	const registered = agents.data?.agents ?? [];
	const resolvedAgent =
		defaultRole !== undefined && registered.some((a) => a.name === defaultRole)
			? (defaultRole as string)
			: null;
	const template = defaults?.defaultPrompt ?? DEFAULT_SEED_PROMPT_TEMPLATE;
	const loading = warrenConfig.isLoading || agents.isLoading || seedStatuses.isLoading;

	const statusMap = seedStatuses.data ?? {};
	const closedRefs = useMemo(
		() => new Set(targets.filter((t) => statusMap[t.ref] === "closed").map((t) => t.ref)),
		[targets, statusMap],
	);
	const dispatchableCount = targets.length - closedRefs.size;

	const [outcomes, setOutcomes] = useState<BatchDispatchOutcome[]>(() =>
		targets.map((t) => ({ ref: t.ref, status: "pending" })),
	);
	// Re-seed outcomes with `skipped` for closed seeds once the probe
	// resolves. The user only sees the dialog finalize its state once
	// `loading` flips false, so flipping outcomes here doesn't race the
	// initial render.
	useEffect(() => {
		if (seedStatuses.data === undefined) return;
		setOutcomes((prev) =>
			prev.map((o) =>
				o.status === "pending" && closedRefs.has(o.ref)
					? { ref: o.ref, status: "skipped", seedStatus: "closed" }
					: o,
			),
		);
	}, [seedStatuses.data, closedRefs]);
	const [dispatching, setDispatching] = useState(false);
	const [done, setDone] = useState(false);

	const providerOverride =
		defaults?.defaultProvider !== undefined && defaults.defaultProvider.length > 0
			? defaults.defaultProvider
			: undefined;
	const modelOverride =
		defaults?.defaultModel !== undefined && defaults.defaultModel.length > 0
			? defaults.defaultModel
			: undefined;

	const dispatchAll = async (): Promise<void> => {
		if (resolvedAgent === null) return;
		setDispatching(true);
		const agent = resolvedAgent;
		await Promise.all(
			targets.map(async (t, idx) => {
				// warren-4015: closed seeds are dropped at confirm time.
				// `outcomes[idx]` is already `skipped` from the effect above;
				// no POST /runs fires for them.
				if (closedRefs.has(t.ref)) return;
				const prompt = template.replaceAll("{seed_id}", t.ref);
				try {
					const resp = await runsApi.create({
						agent,
						project: projectId,
						prompt,
						seedId: t.ref,
						plotId,
						...(providerOverride !== undefined ? { providerOverride } : {}),
						...(modelOverride !== undefined ? { modelOverride } : {}),
					});
					setOutcomes((prev) => {
						const next = prev.slice();
						next[idx] = { ref: t.ref, status: "dispatched", runId: resp.run.id };
						return next;
					});
				} catch (err) {
					const msg =
						err instanceof ApiError
							? `${err.message} (${err.code})`
							: err instanceof Error
								? err.message
								: String(err);
					setOutcomes((prev) => {
						const next = prev.slice();
						next[idx] = { ref: t.ref, status: "failed", error: msg };
						return next;
					});
				}
			}),
		);
		setDispatching(false);
		setDone(true);
		qc.invalidateQueries({ queryKey: ["plot", plotId] });
		qc.invalidateQueries({ queryKey: ["runs"] });
	};

	const readyToDispatch = !loading && resolvedAgent !== null && !dispatching && !done;

	return (
		<Dialog open={true} onOpenChange={(next) => onOpenChange(next)}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Dispatch all attached seeds</DialogTitle>
					<DialogDescription>
						Dispatch <strong>{dispatchableCount}</strong> parallel run
						{dispatchableCount === 1 ? "" : "s"} bound to this Plot, one per
						open seeds_issue. Each run uses the project's default agent
						and prompt template; <code className="font-mono">{"{seed_id}"}</code>
						is substituted per target.
						{closedRefs.size > 0 ? (
							<>
								{" "}
								<strong>{closedRefs.size}</strong> closed
								{closedRefs.size === 1 ? " seed is" : " seeds are"} skipped.
							</>
						) : null}{" "}
						For PR-merge-serial gating and a single tracked PlanRun row,
						prefer the <strong>Dispatch as plan-run</strong> button instead —
						this batch action is the parallel-fan-out escape hatch.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 text-sm">
					<ReadOnlyField label="Project" value={projectId} />
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
						value={template}
						hint="{seed_id} is substituted per target."
					/>
					<div className="space-y-1">
						<div className="text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
							Targets ({targets.length})
						</div>
						<ul className="max-h-40 overflow-auto divide-y rounded-md border">
							{outcomes.map((o) => (
								<li
									key={o.ref}
									className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
								>
									<span className="truncate font-mono">{o.ref}</span>
									<BatchOutcomeBadge outcome={o} />
								</li>
							))}
						</ul>
					</div>
				</div>

				{!loading && resolvedAgent === null ? (
					<p className="text-sm text-(--color-destructive)">
						No default agent resolved. Set{" "}
						<code className="font-mono">defaults.defaultRole</code> in{" "}
						<code className="font-mono">.warren/defaults.yaml</code> and
						register the agent before dispatching in batch.
					</p>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={dispatching}
					>
						{done ? "Close" : "Cancel"}
					</Button>
					{!done ? (
						<Button
							type="button"
							disabled={!readyToDispatch || dispatchableCount === 0}
							onClick={() => {
								void dispatchAll();
							}}
						>
							{dispatching
								? `Dispatching ${dispatchableCount}…`
								: `Dispatch ${dispatchableCount}`}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function BatchOutcomeBadge({ outcome }: { outcome: BatchDispatchOutcome }) {
	if (outcome.status === "pending") {
		return (
			<span className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-(--color-muted-foreground)">
				pending
			</span>
		);
	}
	if (outcome.status === "skipped") {
		return (
			<span
				className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-(--color-muted-foreground)"
				title={`seed status: ${outcome.seedStatus ?? "closed"}`}
			>
				skipped ({outcome.seedStatus ?? "closed"})
			</span>
		);
	}
	if (outcome.status === "dispatched") {
		return (
			<Link
				to={`/runs/${encodeURIComponent(outcome.runId ?? "")}`}
				className="shrink-0 rounded border px-1.5 py-0.5 font-mono underline-offset-2 hover:underline"
			>
				{outcome.runId ?? "dispatched"}
			</Link>
		);
	}
	return (
		<span
			className="shrink-0 truncate rounded border px-1.5 py-0.5 font-mono text-(--color-destructive)"
			title={outcome.error ?? "failed"}
		>
			failed
		</span>
	);
}

/* ----------------------------------------------------------------------- */
/* RunSeedButton (warren-ff2a)                                              */
/* ----------------------------------------------------------------------- */

/**
 * Per-attachment "Run agent" action. Visible on every `seeds_issue`
 * attachment row in SubstratePanel. Clicking navigates to `/runs/new`
 * with pre-filled project/agent/plot_id/prompt so the user can click
 * Dispatch immediately without typing. Agent comes from the project's
 * `.warren/defaults.yaml` `defaultRole`; prompt comes from the project's
 * `defaultPrompt` (with `{seed_id}` substituted) or falls back to
 * `DEFAULT_SEED_PROMPT_TEMPLATE`. The user can still edit any field
 * before submitting — the pre-fill marks fields as touched so NewRun's
 * own defaults auto-fill doesn't clobber the values we just pushed.
 */
function RunSeedButton({
	plotId,
	projectId,
	seedRef,
}: {
	plotId: string;
	projectId: string;
	seedRef: string;
}) {
	const navigate = useNavigate();
	const warrenConfig = useQuery({
		queryKey: ["projects", projectId, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(projectId, signal),
	});
	const agents = useQuery({
		queryKey: ["agents", { projectId }],
		queryFn: ({ signal }) => agentsApi.list({ projectId }, signal),
	});

	const handleClick = (): void => {
		const defaults = warrenConfig.data?.defaults ?? null;
		const defaultRole = defaults?.defaultRole;
		const registered = agents.data?.agents ?? [];
		const resolvedAgent =
			defaultRole !== undefined && registered.some((a) => a.name === defaultRole)
				? defaultRole
				: "";
		const template = defaults?.defaultPrompt ?? DEFAULT_SEED_PROMPT_TEMPLATE;
		const resolvedPrompt = template.replaceAll("{seed_id}", seedRef);
		const state: NewRunRouteState = {
			project: projectId,
			agent: resolvedAgent,
			plotId,
			prompt: resolvedPrompt,
		};
		navigate("/runs/new", { state });
	};

	return (
		<Button
			type="button"
			size="sm"
			variant="outline"
			onClick={handleClick}
			disabled={warrenConfig.isLoading || agents.isLoading}
		>
			Run agent
		</Button>
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

/**
 * Walk the event log once and build a `question_id → question_answered`
 * map. `question_id` is the targeted `question_posed.at` (see
 * `src/plots/question-answerer.ts` and mx-noted in this file's header).
 * Events with unknown shapes (missing `data.question_id`) are skipped.
 */
function buildAnswerMap(events: readonly PlotEvent[]): Map<string, PlotEvent> {
	const out = new Map<string, PlotEvent>();
	for (const ev of events) {
		if (ev.type !== "question_answered") continue;
		const qid = readString((ev.data as { question_id?: unknown }).question_id);
		if (qid === null) continue;
		out.set(qid, ev);
	}
	return out;
}

/**
 * Index `paused_runs[]` by their `paused_question_event_id` so the
 * activity feed can drive the prominent "Answer & resume" affordance
 * on the matching `question_posed` event in O(1) (warren-4ea4 /
 * pl-0344 step 12). Multiple paused runs on the same question event
 * are vanishingly rare in practice (one batch run per Plot at a
 * time), but a Map's last-write-wins matches the seed contract — the
 * UI only needs *some* paused row to fire the countdown.
 */
function buildPausedByQuestion(
	pausedRuns: readonly PausedRunInfo[],
): Map<string, PausedRunInfo> {
	const out = new Map<string, PausedRunInfo>();
	for (const r of pausedRuns) out.set(r.paused_question_event_id, r);
	return out;
}

function ActivityFeed({
	plotId,
	events,
	pausedRuns,
}: {
	plotId: string;
	events: readonly PlotEvent[];
	pausedRuns: readonly PausedRunInfo[];
}) {
	const clusters = useMemo(() => clusterEvents(events), [events]);
	const answers = useMemo(() => buildAnswerMap(events), [events]);
	const pausedByQuestion = useMemo(
		() => buildPausedByQuestion(pausedRuns),
		[pausedRuns],
	);
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
									plotId={plotId}
									events={c.events}
									answers={answers}
									pausedByQuestion={pausedByQuestion}
								/>
							) : (
								<EventLine
									// biome-ignore lint/suspicious/noArrayIndexKey: see
									// above — singles also key on their cluster index.
									key={`evt-${idx}`}
									plotId={plotId}
									event={c.events[0] as PlotEvent}
									answers={answers}
									pausedByQuestion={pausedByQuestion}
								/>
							),
						)}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}

function FoldedCluster({
	plotId,
	events,
	answers,
	pausedByQuestion,
}: {
	plotId: string;
	events: PlotEvent[];
	answers: Map<string, PlotEvent>;
	pausedByQuestion: Map<string, PausedRunInfo>;
}) {
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
					<EventLine
						key={`${e.at}-${e.type}`}
						plotId={plotId}
						event={e}
						answers={answers}
						pausedByQuestion={pausedByQuestion}
					/>
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
function EventLine({
	plotId,
	event,
	answers,
	pausedByQuestion,
}: {
	plotId: string;
	event: PlotEvent;
	answers: Map<string, PlotEvent>;
	pausedByQuestion: Map<string, PausedRunInfo>;
}) {
	const summary = summarizePlotEvent(event);
	const expanded = JSON.stringify(event.data, null, 2);
	const isQuestion = event.type === "question_posed";
	const answer = isQuestion ? answers.get(event.at) : undefined;
	const pausedRun =
		isQuestion && answer === undefined ? pausedByQuestion.get(event.at) : undefined;
	return (
		<li>
			<details className="group">
				<summary className="flex cursor-pointer items-baseline gap-3 rounded-md px-2 py-1 text-sm select-none hover:bg-(--color-accent) [&::-webkit-details-marker]:hidden">
					<ActorSlot actor={event.actor} />
					<span className="shrink-0 font-medium">{event.type}</span>
					{pausedRun !== undefined ? <StateBadge state="paused" /> : null}
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
			{isQuestion && answer !== undefined ? (
				<AnsweredQuestionRow answer={answer} />
			) : null}
			{isQuestion && answer === undefined ? (
				<AnswerCard
					plotId={plotId}
					questionEventId={event.at}
					pausedRun={pausedRun}
				/>
			) : null}
		</li>
	);
}

/**
 * Inline answer affordance (warren-3c3e / pl-9d6a step 15). Rendered
 * below each `question_posed` event that has no matching
 * `question_answered`. Submit POSTs to `/plots/:id/questions/:event_id/answer`
 * and optimistically splices the returned event into the cached plot
 * envelope so the card disappears immediately without waiting for the
 * 5s refetch. On failure the draft is preserved (mutation state holds
 * the textarea via `draft` state) and an inline error surfaces.
 *
 * Paused-run promotion (warren-4ea4 / pl-0344 step 12): when this
 * question is the `paused_question_event_id` of a paused warren run,
 * the card surfaces a primary-colored border + "Answer & resume"
 * heading + countdown to the `agent.pauseTimeoutMs` budget instead of
 * the bare "Your answer" affordance. The countdown re-renders every
 * 1s via a `setInterval` tick driven off `paused_at + pause_timeout_ms`;
 * once the budget elapses the line flips to "Pause budget elapsed —
 * agent will resume with a timeout warning" but the submit stays
 * enabled (the supervisor's resume detector is best-effort, and a
 * late answer still routes through `POST /questions/:id/answer`).
 */
function AnswerCard({
	plotId,
	questionEventId,
	pausedRun,
}: {
	plotId: string;
	questionEventId: string;
	pausedRun: PausedRunInfo | undefined;
}) {
	const qc = useQueryClient();
	const [draft, setDraft] = useState("");

	const mutation = useMutation({
		mutationFn: () =>
			plotsApi.answerQuestion(plotId, {
				eventId: questionEventId,
				answer: draft.trim(),
			}),
		onSuccess: (resp) => {
			// Optimistic-but-server-truthed splice: insert the server-
			// returned event into the cached envelope's event_log so the
			// answer card disappears now, not on the next 5s poll. The
			// refetch will reconcile if anything drifted.
			qc.setQueryData<PlotEnvelope>(["plot", plotId], (prev) => {
				if (prev === undefined) return prev;
				if (prev.event_log.some((e) => e.at === resp.event.at)) return prev;
				return { ...prev, event_log: [...prev.event_log, resp.event] };
			});
			qc.invalidateQueries({ queryKey: ["plot", plotId] });
			setDraft("");
		},
		// On failure: do nothing — `draft` already holds the user's text
		// so they can edit and resubmit (draft-restore-on-failure).
	});

	const submittable = draft.trim().length > 0 && !mutation.isPending;

	const submit = (e: React.FormEvent): void => {
		e.preventDefault();
		if (!submittable) return;
		mutation.mutate();
	};

	const isPaused = pausedRun !== undefined;
	return (
		<form
			onSubmit={submit}
			className={
				isPaused
					? "ml-[11rem] mt-1 mb-2 space-y-2 rounded-md border-2 border-(--color-primary) bg-(--color-accent)/40 p-3 shadow-sm"
					: "ml-[11rem] mt-1 mb-2 space-y-2 rounded-md border border-dashed p-3"
			}
		>
			{isPaused ? (
				<div className="flex flex-wrap items-baseline justify-between gap-2">
					<div className="flex items-baseline gap-2">
						<StateBadge state="paused" />
						<span className="text-sm font-semibold">Answer &amp; resume</span>
						<span className="font-mono text-xs text-(--color-muted-foreground)">
							run {pausedRun.run_id}
						</span>
					</div>
					<PauseCountdown
						pausedAt={pausedRun.paused_at}
						pauseTimeoutMs={pausedRun.pause_timeout_ms}
					/>
				</div>
			) : null}
			<Label htmlFor={`answer-${questionEventId}`} className="text-xs">
				{isPaused ? "Your answer (the run resumes on submit)" : "Your answer"}
			</Label>
			<Textarea
				id={`answer-${questionEventId}`}
				rows={3}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				disabled={mutation.isPending}
				placeholder="Type a reply…"
			/>
			{mutation.isError ? (
				<p className="text-sm text-(--color-destructive)">
					{mutation.error instanceof ApiError
						? `${mutation.error.message} (${mutation.error.code})`
						: mutation.error instanceof Error
							? mutation.error.message
							: String(mutation.error)}
				</p>
			) : null}
			<div className="flex justify-end">
				<Button type="submit" size="sm" disabled={!submittable}>
					{mutation.isPending
						? "Submitting…"
						: isPaused
							? "Answer & resume"
							: "Submit"}
				</Button>
			</div>
		</form>
	);
}

/**
 * Live countdown to the `agent.pauseTimeoutMs` budget for a paused
 * run (warren-4ea4 / pl-0344 step 12). Anchored on `paused_at +
 * pause_timeout_ms` (both surfaced on `PausedRunInfo`); ticks every
 * 1s via a `setInterval`. Past zero the line flips to an
 * "elapsed" message — the run will resume with a timeout warning
 * the next time the pause detector ticks (`src/runs/pause.ts`),
 * but the user can still answer.
 */
function PauseCountdown({
	pausedAt,
	pauseTimeoutMs,
}: {
	pausedAt: string;
	pauseTimeoutMs: number;
}) {
	const deadlineMs = useMemo(() => {
		const t = Date.parse(pausedAt);
		return Number.isNaN(t) ? null : t + pauseTimeoutMs;
	}, [pausedAt, pauseTimeoutMs]);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (deadlineMs === null) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [deadlineMs]);
	if (deadlineMs === null) {
		return (
			<span className="font-mono text-xs text-(--color-muted-foreground)">
				pause budget unknown
			</span>
		);
	}
	const remainingMs = deadlineMs - now;
	if (remainingMs <= 0) {
		return (
			<span className="font-mono text-xs text-(--color-destructive)">
				budget elapsed — agent will resume with timeout warning
			</span>
		);
	}
	return (
		<span className="font-mono text-xs text-(--color-muted-foreground)">
			resumes in {formatRemaining(remainingMs)}
		</span>
	);
}

function formatRemaining(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const mm = minutes.toString().padStart(2, "0");
	const ss = seconds.toString().padStart(2, "0");
	if (hours > 0) return `${hours}:${mm}:${ss}`;
	return `${mm}:${ss}`;
}

/**
 * Compact inline display of a `question_answered` event attached to
 * its `question_posed`. Per the seed contract: closed questions render
 * the answer collapsed below the question, no card. The full answer
 * event still appears as its own row elsewhere in the feed — this is
 * an at-a-glance hint so the question row reads as resolved.
 */
function AnsweredQuestionRow({ answer }: { answer: PlotEvent }) {
	const text = readString(answer.data.text) ?? "";
	return (
		<div className="ml-[11rem] mt-1 mb-2 flex items-baseline gap-2 text-xs">
			<span className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-(--color-muted-foreground)">
				answered
			</span>
			<span className="truncate text-(--color-muted-foreground)" title={text}>
				<span className="font-mono">{answer.actor}</span>
				{text.length > 0 ? <> · {text}</> : null}
			</span>
		</div>
	);
}

/* ----------------------------------------------------------------------- */
/* InteractivePanel (warren-444c / pl-0344 step 11)                         */
/* ----------------------------------------------------------------------- */

/**
 * Agent names recognized as interactive on PlotDetail. The server-side
 * truth lives on the run row's `mode` column (pl-0344 step 1 /
 * warren-67b6) and on the brainstorm/planner built-in agent registry
 * (pl-0344 steps 6+7 / warren-3de8, warren-543d). Plot event_log only
 * exposes the run's `agent` name through `run_dispatched` events, so
 * the UI matches on a small known set; canopy-library variants that
 * override the built-ins by name fall under the same set since they
 * register under the canonical `brainstorm` / `planner` name.
 */
const INTERACTIVE_AGENT_NAMES = new Set(["brainstorm", "planner"]);

interface InteractiveAnchor {
	runId: string;
	agent: string;
	at: string;
}

/**
 * Walk the Plot's event_log in reverse and return the most recent
 * `run_dispatched` event whose `data.agent` is in the interactive set.
 * `null` when no interactive run has ever been dispatched against this
 * Plot. Each interactive turn is its own run row (respawn-per-turn,
 * src/runs/interactive.ts) but `Chat`'s `onTurnSpawned` re-anchor only
 * fires from inside the component — the activity feed sees every spawn
 * as a fresh `run_dispatched`, so picking the latest tracks the live
 * conversation handle.
 */
function findLatestInteractiveRun(
	events: readonly PlotEvent[],
): InteractiveAnchor | null {
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const ev = events[i];
		if (ev === undefined || ev.type !== "run_dispatched") continue;
		const agent = readString(ev.data.agent);
		const runId = readString(ev.data.run_id);
		if (agent === null || runId === null) continue;
		if (!INTERACTIVE_AGENT_NAMES.has(agent)) continue;
		return { runId, agent, at: ev.at };
	}
	return null;
}

function InteractivePanel({ plot, frozen }: { plot: PlotEnvelope; frozen: boolean }) {
	const latest = useMemo(() => findLatestInteractiveRun(plot.event_log), [plot.event_log]);
	// The anchor handle the inline `<Chat />` follows. Defaults to the
	// latest interactive run on the Plot; Chat's `onTurnSpawned` rebinds
	// it onto each new turn so the agent reply streams against the live
	// run id (warren-ea98 wire contract).
	const [activeRunId, setActiveRunId] = useState<string | null>(latest?.runId ?? null);
	const [activeAgent, setActiveAgent] = useState<string | null>(latest?.agent ?? null);
	const [dispatchKind, setDispatchKind] = useState<"brainstorm" | "planner" | null>(null);
	const [formalizeOpen, setFormalizeOpen] = useState(false);

	// Reconcile when a new interactive run lands via the 5s poll — only
	// when the user hasn't already re-anchored onto a spawned turn this
	// session. The seq-style check is by run id, not by ts, so a stale
	// poll can't bump a fresh `onTurnSpawned` re-anchor back to the older
	// run id.
	useEffect(() => {
		if (latest === null) return;
		if (activeRunId === null) {
			setActiveRunId(latest.runId);
			setActiveAgent(latest.agent);
		}
	}, [latest, activeRunId]);

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0">
				<CardTitle>Interactive</CardTitle>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setFormalizeOpen(true)}
						disabled={frozen}
						title={
							frozen
								? "Intent is frozen — transition the Plot to drafting/ready first"
								: undefined
						}
					>
						Formalize
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setDispatchKind("planner")}
						disabled={frozen}
					>
						Run planner
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={() => {
							if (activeRunId !== null && activeAgent === "brainstorm") {
								// Already brainstorming — just scroll the chat
								// transcript into view (mirrors seed's "else opens
								// chat" wording).
								document
									.getElementById("interactive-chat")
									?.scrollIntoView({ behavior: "smooth", block: "start" });
								return;
							}
							setDispatchKind("brainstorm");
						}}
						disabled={frozen}
					>
						Start brainstorming
					</Button>
				</div>
			</CardHeader>
			<CardContent>
				{activeRunId === null ? (
					<p className="text-sm text-(--color-muted-foreground)">
						No interactive conversation yet. Start brainstorming to sharpen
						this Plot's intent, or run the planner to scout the repo and
						submit a structured <code className="font-mono">sd plan</code>.
					</p>
				) : (
					<div id="interactive-chat" className="h-[480px]">
						<Chat
							runId={activeRunId}
							follow
							onTurnSpawned={(turnId) => setActiveRunId(turnId)}
							header={
								<div className="flex items-center gap-2 text-xs text-(--color-muted-foreground)">
									<span className="rounded border px-1.5 py-0.5 font-mono">
										{activeAgent ?? "interactive"}
									</span>
									<Link
										to={`/runs/${encodeURIComponent(activeRunId)}`}
										className="font-mono underline-offset-2 hover:underline"
									>
										{activeRunId}
									</Link>
								</div>
							}
							placeholder="Continue the conversation…"
						/>
					</div>
				)}
			</CardContent>

			{dispatchKind !== null ? (
				<DispatchInteractiveDialog
					plotId={plot.id}
					projectId={plot.project_id}
					agentName={dispatchKind}
					onOpenChange={(open) => {
						if (!open) setDispatchKind(null);
					}}
					onDispatched={(run) => {
						setActiveRunId(run.id);
						setActiveAgent(dispatchKind);
						setDispatchKind(null);
					}}
				/>
			) : null}

			{formalizeOpen ? (
				<FormalizeDialog
					plot={plot}
					onOpenChange={(open) => setFormalizeOpen(open)}
				/>
			) : null}
		</Card>
	);
}

const BRAINSTORM_OPENER = "I want to sharpen the intent of this Plot. Help me think through what it's really for.";
const PLANNER_OPENER = "Read the Plot intent, scout the repo, and propose a structured plan.";

function DispatchInteractiveDialog({
	plotId,
	projectId,
	agentName,
	onOpenChange,
	onDispatched,
}: {
	plotId: string;
	projectId: string;
	agentName: "brainstorm" | "planner";
	onOpenChange: (open: boolean) => void;
	onDispatched: (run: { id: string }) => void;
}) {
	const qc = useQueryClient();
	const [prompt, setPrompt] = useState(
		agentName === "brainstorm" ? BRAINSTORM_OPENER : PLANNER_OPENER,
	);

	const dispatch = useMutation({
		mutationFn: () =>
			runsApi.createInteractive({
				agent: agentName,
				project: projectId,
				plotId,
				prompt: prompt.trim(),
			}),
		onSuccess: (resp) => {
			qc.invalidateQueries({ queryKey: ["plot", plotId] });
			qc.invalidateQueries({ queryKey: ["runs"] });
			onDispatched(resp.run);
		},
	});

	const submittable = prompt.trim().length > 0 && !dispatch.isPending;

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
					<DialogTitle>
						{agentName === "brainstorm" ? "Start brainstorming" : "Run planner"}
					</DialogTitle>
					<DialogDescription>
						{agentName === "brainstorm"
							? "Dispatch a brainstorm interactive run bound to this Plot. The brainstorm agent is a read-only scout — it asks questions, never writes source. Use Formalize to convert the conversation into a suggested intent."
							: "Dispatch a planner interactive run bound to this Plot. The planner reads intent, scouts the repo, asks clarifying questions, and submits a structured sd plan; writes are restricted to .plot/ and .seeds/."}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 text-sm">
					<ReadOnlyField label="Plot" value={plotId} />
					<ReadOnlyField label="Project" value={projectId} />
					<ReadOnlyField label="Agent" value={agentName} />
					<div className="space-y-1.5">
						<Label htmlFor="interactive-opener">Opening message</Label>
						<Textarea
							id="interactive-opener"
							rows={4}
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							disabled={dispatch.isPending}
						/>
						<p className="text-xs text-(--color-muted-foreground)">
							First-turn prompt. The agent reads Plot intent +
							attachments on its own; this message is what you'd type.
						</p>
					</div>
				</div>

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
						disabled={!submittable}
						onClick={() => dispatch.mutate()}
					>
						{dispatch.isPending ? "Dispatching…" : "Dispatch"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Formalize dialog (warren-444c / pl-0344 step 11). Calls
 * `POST /plots/:id/formalize` (warren-d22e) to extract a suggested
 * intent from the brainstorm conversation, renders it as an editable
 * review form, and on accept POSTs to `POST /plots/:id/intent` via
 * the existing `plotsApi.editIntent` route. Non-mutating until accept;
 * the seam contract is that formalize returns a starting point, the
 * user owns the final intent shape.
 */
function FormalizeDialog({
	plot,
	onOpenChange,
}: {
	plot: PlotEnvelope;
	onOpenChange: (open: boolean) => void;
}) {
	const qc = useQueryClient();
	const suggestion = useQuery({
		queryKey: ["plot", plot.id, "formalize"],
		queryFn: () => plotsApi.formalize(plot.id),
		// Don't auto-poll; the suggestion is a snapshot of the conversation
		// at click-time. Re-open the dialog to refetch.
		staleTime: Infinity,
		gcTime: 0,
	});

	const [draft, setDraft] = useState<IntentDraft>(() => intentToDraft(plot));
	const [hydrated, setHydrated] = useState(false);

	// Hydrate the form once the suggestion arrives. Merge strategy:
	// keep the suggestion verbatim (it's the whole point of the seam),
	// preserve current Plot intent only when the suggestion field is
	// empty so an empty conversation doesn't blow existing intent away.
	useEffect(() => {
		if (hydrated) return;
		const s = suggestion.data?.suggested_intent;
		if (s === undefined) return;
		setDraft({
			goal: s.goal.length > 0 ? s.goal : plot.intent.goal,
			non_goals:
				s.non_goals.length > 0
					? s.non_goals.join("\n")
					: plot.intent.non_goals.join("\n"),
			constraints:
				s.constraints.length > 0
					? s.constraints.join("\n")
					: plot.intent.constraints.join("\n"),
			success_criteria:
				s.success_criteria.length > 0
					? s.success_criteria.join("\n")
					: plot.intent.success_criteria.join("\n"),
		});
		setHydrated(true);
	}, [suggestion.data, hydrated, plot.intent]);

	const apply = useMutation({
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
			onOpenChange(false);
		},
	});

	const errorMessage = ((): string | null => {
		if (suggestion.error !== null && suggestion.error !== undefined) {
			return suggestion.error instanceof ApiError
				? `${suggestion.error.message} (${suggestion.error.code})`
				: suggestion.error instanceof Error
					? suggestion.error.message
					: String(suggestion.error);
		}
		if (apply.error !== null && apply.error !== undefined) {
			return apply.error instanceof ApiError
				? `${apply.error.message} (${apply.error.code})`
				: apply.error instanceof Error
					? apply.error.message
					: String(apply.error);
		}
		return null;
	})();

	const sourceCount = suggestion.data?.source_message_count ?? 0;

	return (
		<Dialog
			open={true}
			onOpenChange={(next) => {
				if (!next) apply.reset();
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Formalize intent</DialogTitle>
					<DialogDescription>
						Suggested intent extracted from the brainstorm conversation.
						Review, edit, and accept to apply via{" "}
						<code className="font-mono">POST /plots/:id/intent</code>.
						Cancel to leave the Plot intent untouched.
					</DialogDescription>
				</DialogHeader>

				{suggestion.isLoading ? (
					<p className="text-sm text-(--color-muted-foreground)">
						Extracting suggestion…
					</p>
				) : (
					<div className="space-y-4">
						<p className="text-xs text-(--color-muted-foreground)">
							Based on{" "}
							<strong>{sourceCount}</strong> agent message
							{sourceCount === 1 ? "" : "s"}.{" "}
							{sourceCount === 0
								? "Start chatting in the Interactive panel first — there's nothing to formalize yet."
								: "Empty fields fell back to the current Plot intent."}
						</p>
						<div className="space-y-1.5">
							<Label htmlFor="formalize-goal">Goal</Label>
							<Textarea
								id="formalize-goal"
								rows={3}
								value={draft.goal}
								onChange={(e) =>
									setDraft((d) => ({ ...d, goal: e.target.value }))
								}
								disabled={apply.isPending}
							/>
						</div>
						<IntentListField
							id="formalize-non_goals"
							label="Non-goals"
							value={draft.non_goals}
							onChange={(v) => setDraft((d) => ({ ...d, non_goals: v }))}
							disabled={apply.isPending}
						/>
						<IntentListField
							id="formalize-constraints"
							label="Constraints"
							value={draft.constraints}
							onChange={(v) => setDraft((d) => ({ ...d, constraints: v }))}
							disabled={apply.isPending}
						/>
						<IntentListField
							id="formalize-success_criteria"
							label="Success criteria"
							value={draft.success_criteria}
							onChange={(v) =>
								setDraft((d) => ({ ...d, success_criteria: v }))
							}
							disabled={apply.isPending}
						/>
					</div>
				)}

				{errorMessage !== null ? (
					<p className="text-sm text-(--color-destructive)">{errorMessage}</p>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={apply.isPending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={
							suggestion.isLoading ||
							apply.isPending ||
							suggestion.isError
						}
						onClick={() => apply.mutate()}
					>
						{apply.isPending ? "Applying…" : "Accept & apply"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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
