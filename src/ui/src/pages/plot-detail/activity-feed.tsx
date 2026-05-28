import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError, plotsApi } from "@/api/client.ts";
import type { PausedRunInfo, PlotEnvelope, PlotEvent } from "@/api/types.ts";
import { StateBadge } from "@/components/StateBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import { readString } from "./helpers.ts";

/**
 * ActivityFeed — unified event_log timeline for a Plot. Collapses
 * runs of 3+ same-kind same-actor events into a fold; renders an
 * inline AnswerCard below open `question_posed` events
 * (mx-f9bbf7), and a PauseCountdown when a paused run is anchored
 * on the question. Tail helpers (`ActorSlot`, `summarizePlotEvent`)
 * are kept here because they only feed EventLine + FoldedCluster.
 */

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

export function ActivityFeed({
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
				<div className="ml-28 mt-1 mb-2 space-y-1 sm:ml-[11rem]">
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
					? "ml-28 mt-1 mb-2 space-y-2 rounded-md border-2 border-(--color-primary) bg-(--color-accent)/40 p-3 shadow-sm sm:ml-[11rem]"
					: "ml-28 mt-1 mb-2 space-y-2 rounded-md border border-dashed p-3 sm:ml-[11rem]"
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
		<div className="ml-28 mt-1 mb-2 flex items-baseline gap-2 text-xs sm:ml-[11rem]">
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

function ActorSlot({ actor }: { actor: string }) {
	return (
		<span
			className="w-24 shrink-0 truncate font-mono text-xs text-(--color-muted-foreground) sm:w-40"
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
