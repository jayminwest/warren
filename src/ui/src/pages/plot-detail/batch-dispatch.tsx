import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { agentsApi, ApiError, projectsApi, runsApi } from "@/api/client.ts";
import type { MergePlotPrOutcome, PlotAttachment } from "@/api/types.ts";
import type { NewRunRouteState } from "@/pages/NewRun.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { relativeTime } from "@/lib/utils.ts";
import { ReadOnlyField } from "./run-plan.tsx";

/**
 * Batch-dispatch flow (warren-7c3f / pl-5310 step 3): fans every
 * non-sd_plan `seeds_issue` attachment out to an individual run.
 * MergeOutcomeBanner renders the shared "merge PR" result both here
 * and on per-row Merge buttons in SubstratePanel. RunSeedButton
 * (warren-ff2a) is the per-attachment "Run agent" affordance.
 */

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
export function MergeOutcomeBanner({ outcome }: { outcome: MergePlotPrOutcome }) {
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
export function BatchDispatchAllButton({
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
export function RunSeedButton({
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

