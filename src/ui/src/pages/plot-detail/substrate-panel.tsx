import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { plotsApi } from "@/api/client.ts";
import {
	ATTACHMENT_TYPES,
	type AttachmentType,
	type PlotAttachment,
	type PlotEnvelope,
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
import { responsiveCardHeaderRow } from "@/components/ui/responsive.ts";
import { relativeTime } from "@/lib/utils.ts";
import {
	BatchDispatchAllButton,
	MergeOutcomeBanner,
	RunSeedButton,
} from "./batch-dispatch.tsx";
import { isBatchDispatchTarget, isSdPlanAttachment } from "./helpers.ts";
import { DispatchAsPlanRunButton, RunPlanButton } from "./run-plan.tsx";

/**
 * SubstratePanel — attachments grouped by role, with Add/Detach dialog
 * and per-row affordances (Run plan / Dispatch as plan-run / Run seed
 * / Merge PR). Renders the Plot-side "Dispatch all" header button when
 * the Plot has any non-sd_plan seeds_issue attachments.
 */

/* ----------------------------------------------------------------------- */
/* SubstratePanel                                                           */
/* ----------------------------------------------------------------------- */

export function SubstratePanel({ plot }: { plot: PlotEnvelope }) {
	const [dialogOpen, setDialogOpen] = useState(false);

	const grouped = useMemo(() => groupAttachmentsByRole(plot.attachments), [plot.attachments]);
	const batchTargets = useMemo(
		() => plot.attachments.filter(isBatchDispatchTarget),
		[plot.attachments],
	);

	return (
		<Card>
			<CardHeader className={responsiveCardHeaderRow}>
				<CardTitle>Substrate</CardTitle>
				<div className="flex flex-wrap items-center gap-2">
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

