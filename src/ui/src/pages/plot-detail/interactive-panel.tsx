import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, plotsApi, runsApi } from "@/api/client.ts";
import type { PlotEnvelope, PlotEvent } from "@/api/types.ts";
import { Chat } from "@/components/Chat.tsx";
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
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { readString } from "./helpers.ts";
import {
	type IntentDraft,
	IntentListField,
	intentToDraft,
	splitLines,
} from "./intent-panel.tsx";
import { ReadOnlyField } from "./run-plan.tsx";

/**
 * InteractivePanel (warren-444c / pl-0344 step 11) — renders Start
 * brainstorming / Run planner / Formalize over an inline Chat anchored
 * to the latest interactive run on the Plot. The agent's reply streams
 * back into the transcript via reap-side `agent_message` capture
 * (warren-509f, src/runs/reap/interactive.ts).
 */

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

export function InteractivePanel({ plot, frozen }: { plot: PlotEnvelope; frozen: boolean }) {
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
			<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
				<div className="flex items-center gap-2">
					<CardTitle>Interactive</CardTitle>
				</div>
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
					<div className="flex flex-col gap-2">
						<p className="text-sm text-(--color-muted-foreground)">
							No interactive conversation yet. Start brainstorming to
							sharpen this Plot's intent, or run the planner to scout the
							repo and submit a structured{" "}
							<code className="font-mono">sd plan</code>.
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-2">
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
const PLANNER_OPENER =
	"Read the Plot intent, scout the repo, and submit a structured plan (sd plan submit). Warren will commit and push your .seeds/ + .plot/ deltas at reap; you don't need to run git.";

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

