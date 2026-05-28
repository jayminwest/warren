import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { ApiError, plotsApi } from "@/api/client.ts";
import { type PlotEnvelope, PLOT_STATUSES, type PlotStatus } from "@/api/types.ts";
import { PlotStatusBadge } from "@/components/PlotStatusBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

/**
 * Header controls for the PlotDetail page (warren-2221 / pl-55a3 step
 * 8): the GitHub sync button (warren-1d0c), inline name editor
 * (warren-bed0 / pl-b0c0 step 3), and SPEC §6.5 status-transition
 * dropdown (warren-6336 / warren-470e). Lifted out of PlotDetail.tsx
 * verbatim — see mx-8df9b9, mx-a2ca6d for behavior notes.
 */

export function PlotSyncButton({ plotId }: { plotId: string }) {
	const qc = useQueryClient();
	const [statusMessage, setStatusMessage] = useState<{
		text: string;
		type: "success" | "info" | "error";
		prUrl?: string;
	} | null>(null);

	const mutation = useMutation({
		mutationFn: () => plotsApi.sync(plotId),
		onSuccess: (resp) => {
			if (resp.kind === "no_op") {
				setStatusMessage({
					text: "Everything is already up to date on GitHub.",
					type: "info",
				});
			} else {
				setStatusMessage({
					text: resp.merged
						? `Synced & merged sync branch ${resp.branch}!`
						: `Synced! Opened PR for branch ${resp.branch}.`,
					type: "success",
					prUrl: resp.prUrl,
				});
			}
			qc.invalidateQueries({ queryKey: ["plot", plotId] });
		},
		onError: (err) => {
			const msg =
				err instanceof ApiError
					? `${err.message} (${err.code})`
					: err instanceof Error
						? err.message
						: String(err);
			setStatusMessage({
				text: `Sync failed: ${msg}`,
				type: "error",
			});
		},
	});

	// Auto-clear success/info messages after some seconds, but keep error visible
	useEffect(() => {
		if (statusMessage && statusMessage.type !== "error") {
			const t = setTimeout(() => setStatusMessage(null), 8000);
			return () => clearTimeout(t);
		}
	}, [statusMessage]);

	return (
		<div className="flex flex-col items-end gap-1">
			<div className="flex flex-wrap items-center justify-end gap-2">
				{statusMessage ? (
					<span
						className={`text-xs ${
							statusMessage.type === "error"
								? "text-(--color-destructive)"
								: statusMessage.type === "success"
									? "text-emerald-700 dark:text-emerald-300"
									: "text-(--color-muted-foreground)"
						}`}
					>
						{statusMessage.text}
						{statusMessage.prUrl && (
							<a
								href={statusMessage.prUrl}
								target="_blank"
								rel="noreferrer"
								className="ml-1 font-medium underline hover:text-(--color-primary)"
							>
								View PR
							</a>
						)}
					</span>
				) : null}
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 gap-1.5"
					disabled={mutation.isPending}
					onClick={() => {
						setStatusMessage(null);
						mutation.mutate();
					}}
				>
					<GitBranch className={`h-3.5 w-3.5 ${mutation.isPending ? "animate-spin" : ""}`} />
					{mutation.isPending ? "Syncing to GitHub…" : "Sync to GitHub"}
				</Button>
			</div>
		</div>
	);
}

/* ----------------------------------------------------------------------- */
/* PlotNameEditor (warren-bed0 / pl-b0c0 step 3)                            */
/* ----------------------------------------------------------------------- */

/**
 * Inline name editor for a Plot. Displays the current name as an
 * `<h1>`; clicking the heading (or the small "rename" affordance)
 * swaps it for an `<input>` + Save/Cancel buttons. Saving POSTs to
 * `/plots/:id/rename` via `plotsApi.rename`; on success the cached
 * envelope's `name` flips immediately (optimistic) and the server
 * response's full envelope replaces the cache entry.
 *
 * Empty-after-trim or no-change submissions are short-circuited
 * client-side so the user doesn't pay a round-trip for a no-op.
 * Errors are surfaced inline (status + message) without dropping the
 * user out of edit mode.
 */
export function PlotNameEditor({ plot }: { plot: PlotEnvelope }) {
	const qc = useQueryClient();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(plot.name);

	// Re-sync draft when the underlying name changes from elsewhere
	// (concurrent rename, refetch). Keep the user's draft if they're
	// actively editing.
	useEffect(() => {
		if (!editing) setDraft(plot.name);
	}, [plot.name, editing]);

	const mutation = useMutation({
		mutationFn: (name: string) => plotsApi.rename(plot.id, { name }),
		onSuccess: (envelope) => {
			qc.setQueryData<PlotEnvelope>(["plot", plot.id], envelope);
			qc.invalidateQueries({ queryKey: ["plots"] });
			setEditing(false);
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

	function submit() {
		const trimmed = draft.trim();
		if (trimmed.length === 0) return;
		if (trimmed === plot.name) {
			setEditing(false);
			return;
		}
		mutation.mutate(trimmed);
	}

	if (!editing) {
		return (
			<div className="flex items-center gap-2">
				<h1 className="text-2xl font-semibold tracking-tight">{plot.name}</h1>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="text-xs text-(--color-muted-foreground)"
					onClick={() => {
						setDraft(plot.name);
						mutation.reset();
						setEditing(true);
					}}
					aria-label="Rename plot"
				>
					rename
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-1">
			<div className="flex flex-wrap items-center gap-2">
				<Input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							submit();
						} else if (e.key === "Escape") {
							e.preventDefault();
							setEditing(false);
						}
					}}
					disabled={mutation.isPending}
					autoFocus
					aria-label="New plot name"
					className="h-9 max-w-md text-base font-semibold"
				/>
				<Button
					type="button"
					size="sm"
					onClick={submit}
					disabled={
						mutation.isPending ||
						draft.trim().length === 0 ||
						draft.trim() === plot.name
					}
				>
					{mutation.isPending ? "Saving…" : "Save"}
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setEditing(false)}
					disabled={mutation.isPending}
				>
					Cancel
				</Button>
			</div>
			{errorMessage !== null ? (
				<p className="text-xs text-(--color-destructive)">{errorMessage}</p>
			) : null}
		</div>
	);
}

/* ----------------------------------------------------------------------- */
/* StatusTransitionControl (warren-6336 / warren-470e dropdown refactor)   */
/* ----------------------------------------------------------------------- */

/**
 * SPEC §6.5 transition matrix mirrored from
 * `src/plots/status-changer.ts` `STATUS_TRANSITIONS`. Kept as a UI-side
 * constant so the dropdown can render before the request reaches the
 * server; the server re-validates authoritatively. If the matrix ever
 * drifts, the server's `PlotIllegalStatusTransitionError` surfaces
 * inline below the dropdown so the mistake is loud rather than silent.
 *
 * warren-470e: previously a button group (one Button per legal next),
 * which felt forward-only and didn't scale visually past two options.
 * The dropdown surfaces every legally-reachable phase under a single
 * affordance (an explicit '→ status' Apply control) and keeps the
 * server contract unchanged. Phases not in the matrix are rendered
 * disabled so operators see the full set and understand why the rest
 * are unreachable from here.
 */
const NEXT_STATUSES: Readonly<Record<PlotStatus, readonly PlotStatus[]>> = {
	drafting: ["ready", "archived"],
	ready: ["active", "archived"],
	active: ["done", "archived"],
	done: ["archived"],
	archived: [],
};

export function StatusTransitionControl({ plot }: { plot: PlotEnvelope }) {
	const qc = useQueryClient();
	const nexts = NEXT_STATUSES[plot.status];
	const [selected, setSelected] = useState<PlotStatus | "">("");

	// Reset the dropdown selection whenever the plot's current status
	// changes (either by our own mutation or a poll-time refetch picking
	// up an out-of-band change). Keeps the chooser pointed at "pick a
	// phase" rather than stale-locked on the previous target.
	useEffect(() => {
		setSelected("");
	}, [plot.status]);

	const mutation = useMutation({
		mutationFn: (next: PlotStatus) => plotsApi.changeStatus(plot.id, { next }),
		onMutate: async (next) => {
			// Optimistic: cancel in-flight refetches and patch the cached
			// envelope so the badge + dropdown flip immediately. The
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

	const canApply =
		selected !== "" && !mutation.isPending && nexts.includes(selected);

	return (
		<div className="flex flex-col items-end gap-2">
			<PlotStatusBadge status={plot.status} />
			{nexts.length === 0 ? (
				<p className="text-xs text-(--color-muted-foreground)">
					Terminal status — no further transitions.
				</p>
			) : (
				<div className="flex flex-wrap items-center justify-end gap-2">
					<Label htmlFor={`plot-status-next-${plot.id}`} className="sr-only">
						Change status
					</Label>
					<select
						id={`plot-status-next-${plot.id}`}
						value={selected}
						disabled={mutation.isPending}
						onChange={(e) => setSelected(e.target.value as PlotStatus | "")}
						className="flex h-9 rounded-md border bg-(--color-card) px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) disabled:cursor-not-allowed disabled:opacity-50"
						aria-label="Change status"
					>
						<option value="">Change status…</option>
						{PLOT_STATUSES.filter((s) => s !== plot.status).map((s) => {
							const legal = nexts.includes(s);
							return (
								<option key={s} value={s} disabled={!legal}>
									{legal ? `→ ${s}` : `→ ${s} (not allowed from ${plot.status})`}
								</option>
							);
						})}
					</select>
					<Button
						type="button"
						size="sm"
						variant={selected === "archived" ? "outline" : "default"}
						disabled={!canApply}
						onClick={() => {
							if (selected === "") return;
							mutation.mutate(selected);
						}}
					>
						{mutation.isPending && mutation.variables !== undefined
							? `→ ${mutation.variables}…`
							: "Apply"}
					</Button>
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

