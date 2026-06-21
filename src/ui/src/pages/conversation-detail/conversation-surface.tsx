import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { conversationsApi, plotsApi, runsApi } from "@/api/client.ts";
import { RUN_TERMINAL_STATES } from "@/api/types.ts";
import type { ConversationRow, EditPlotIntentInput, PlotEnvelope, PlotStatus } from "@/api/types.ts";
import { Chat } from "@/components/Chat.tsx";
import { PlotStatusBadge } from "@/components/PlotStatusBadge.tsx";
import { StateBadge } from "@/components/StateBadge.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { formatError } from "@/lib/format-error.ts";
import { SendOffButton } from "./send-off-button.tsx";

/**
 * The shared Leveret conversation split-view body (extracted from
 * ConversationDetailPage in pl-0008 step 7 / warren-3de4 so the Workspace
 * Shape tab and the legacy /leveret/:id page render an identical surface):
 *
 * LEFT: the streamed leveret chat, anchored on the conversation's long-lived
 * `mode:'conversation'` run. Reuses `Chat` with a `sendMessage` override so
 * operator turns ride `POST /conversations/:id/messages` (persist + steer)
 * instead of spawning a fresh turn run.
 *
 * RIGHT: the Plot intent being shaped — rendered DYNAMICALLY from the plot's
 * intent JSON shape (no hardcoded goal/non-goals/… fields), operator-EDITABLE
 * via `POST /plots/:id/intent`, and live-updating (the plot query polls so a
 * leveret `propose_intent -> intent_edited` edit shows up within seconds). The
 * intent pane also carries the SendOff action; once a conversation is closed
 * (post send-off) the whole surface goes read-only/quiet.
 */
export function ConversationSplitView({
	conversationId,
}: {
	conversationId: string;
}): JSX.Element {
	const conversation = useQuery({
		queryKey: ["conversation", conversationId],
		queryFn: ({ signal }) => conversationsApi.get(conversationId, signal),
		refetchInterval: 5000,
		enabled: conversationId.length > 0,
	});

	const row = conversation.data?.conversation;
	const isActive = row?.status === "active";

	const anchoringRunId = row?.anchoringRunId;
	const anchoringRun = useQuery({
		queryKey: ["run", anchoringRunId],
		queryFn: ({ signal }) => runsApi.get(anchoringRunId ?? "", signal),
		enabled: anchoringRunId !== null && anchoringRunId !== undefined && anchoringRunId !== "",
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) return 5000;
			return RUN_TERMINAL_STATES.includes(data.state) ? false : 3000;
		},
	});

	const isAnchoringRunTerminal =
		anchoringRun.data !== undefined && RUN_TERMINAL_STATES.includes(anchoringRun.data.state);

	const anchoringRunFailed =
		anchoringRun.data !== undefined && anchoringRun.data.state === "failed";
	const anchoringFailureReason = anchoringRunFailed ? anchoringRun.data?.failureReason : null;

	if (conversation.isLoading) {
		return <p className="text-sm text-(--color-muted-foreground)">Loading conversation…</p>;
	}
	if (conversation.isError) {
		return (
			<p className="text-sm text-(--color-destructive)">{formatError(conversation.error)}</p>
		);
	}
	if (row === undefined) {
		return <></>;
	}

	return (
		<div className="grid h-full min-h-0 gap-4 overflow-y-auto lg:auto-rows-fr lg:grid-cols-2 lg:overflow-hidden">
			<Card className="flex min-h-[60vh] flex-col lg:min-h-0">
				<CardHeader className="shrink-0">
					<CardTitle className="flex flex-wrap items-center gap-2">
						<span>Conversation</span>
						<span className="rounded-full border px-2 py-0.5 text-xs">{row.status}</span>
						{anchoringRun.data !== undefined ? (
							<StateBadge state={anchoringRun.data.state} />
						) : null}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex min-h-0 flex-1 flex-col p-3 pt-0">
					{anchoringRunFailed ? (
						<Alert variant="danger" title="Anchoring run failed" className="mb-3">
							{anchoringFailureReason
								? `The conversation's anchoring run failed — ${anchoringFailureReason}.`
								: "The conversation's anchoring run failed."}{" "}
							Re-wake the conversation to resume chatting.
						</Alert>
					) : null}
					{row.anchoringRunId === null ? (
						<p className="text-sm text-(--color-muted-foreground)">
							No anchoring run — re-wake the conversation to resume chatting.
						</p>
					) : (
						<Chat
							key={row.anchoringRunId}
							runId={row.anchoringRunId}
							transcript={conversation.data?.messages}
							follow={isActive && !isAnchoringRunTerminal}
							disabled={!isActive || isAnchoringRunTerminal}
							placeholder={
								!isActive
									? "This conversation is closed."
									: isAnchoringRunTerminal
										? "Run has completed. Re-wake the conversation to resume chatting."
										: "Steer the leveret…"
							}
							sendMessage={async (message) => {
								await conversationsApi.postMessage(conversationId, { message });
							}}
						/>
					)}
				</CardContent>
			</Card>

			<IntentPane conversation={row} />
		</div>
	);
}

/** A single intent field: either free text or a list of bullet lines. */
interface IntentField {
	key: string;
	label: string;
	kind: "text" | "list";
	value: string; // editor representation: text as-is, list joined by "\n".
}

/** snake_case / kebab key → human label ("non_goals" → "Non goals"). */
function labelForKey(key: string): string {
	const spaced = key.replace(/[_-]+/g, " ").trim();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Derive the dynamic field list from a plot's intent JSON shape. */
export function fieldsFromIntent(intent: Record<string, unknown>): IntentField[] {
	return Object.entries(intent).map(([key, raw]) => {
		if (Array.isArray(raw)) {
			return {
				key,
				label: labelForKey(key),
				kind: "list" as const,
				value: raw.map((v) => String(v)).join("\n"),
			};
		}
		return {
			key,
			label: labelForKey(key),
			kind: "text" as const,
			value: typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw),
		};
	});
}

/** True when any field carries a non-empty value. */
function intentIsNonEmpty(fields: IntentField[]): boolean {
	return fields.some((f) => f.value.trim().length > 0);
}

/** Build the `POST /plots/:id/intent` patch from the edited fields. */
export function patchFromFields(fields: IntentField[]): EditPlotIntentInput {
	const patch: Record<string, unknown> = {};
	for (const f of fields) {
		if (f.kind === "list") {
			patch[f.key] = f.value
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		} else {
			patch[f.key] = f.value;
		}
	}
	return patch as EditPlotIntentInput;
}

const FROZEN_STATUSES: readonly PlotStatus[] = ["done", "archived"];

function IntentPane({ conversation }: { conversation: ConversationRow }): JSX.Element {
	const queryClient = useQueryClient();
	const [drafts, setDrafts] = useState<Record<string, string> | null>(null);

	const plotId = conversation.plotId;
	const plot = useQuery({
		queryKey: ["plot", plotId],
		queryFn: ({ signal }) => plotsApi.get(plotId ?? "", signal),
		refetchInterval: 4000,
		enabled: plotId !== null,
	});

	const baseFields = useMemo<IntentField[]>(
		() =>
			plot.data
				? fieldsFromIntent(plot.data.intent as unknown as Record<string, unknown>)
				: [],
		[plot.data],
	);

	const editing = drafts !== null;
	const editFields = useMemo<IntentField[]>(
		() =>
			drafts === null
				? baseFields
				: baseFields.map((f) => ({ ...f, value: drafts[f.key] ?? f.value })),
		[baseFields, drafts],
	);

	const frozen =
		(plot.data ? FROZEN_STATUSES.includes(plot.data.status) : false) ||
		conversation.status === "closed";

	const save = useMutation({
		mutationFn: (fields: IntentField[]) =>
			plotsApi.editIntent(plotId ?? "", patchFromFields(fields)),
		onSuccess: (envelope: PlotEnvelope) => {
			queryClient.setQueryData(["plot", plotId], envelope);
			setDrafts(null);
		},
	});

	if (plotId === null) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Plot intent</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-(--color-muted-foreground)">
						This conversation is not bound to a Plot.
					</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="flex min-h-[60vh] flex-col lg:min-h-0">
			<CardHeader className="shrink-0">
				<CardTitle className="flex flex-wrap items-center justify-between gap-2">
					<span className="flex items-center gap-2">
						<span>{plot.data?.name || "Plot intent"}</span>
						{plot.data ? <PlotStatusBadge status={plot.data.status} /> : null}
					</span>
					<Link
						to={`/plots/${encodeURIComponent(plotId)}`}
						className="text-xs underline-offset-2 hover:underline"
					>
						Open Plot ↗
					</Link>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
				{plot.isLoading ? (
					<p className="text-sm text-(--color-muted-foreground)">Loading intent…</p>
				) : plot.isError ? (
					<p className="text-sm text-(--color-destructive)">{formatError(plot.error)}</p>
				) : baseFields.length === 0 ? (
					<p className="text-sm text-(--color-muted-foreground)">
						No intent yet — chat with the leveret to start shaping it.
					</p>
				) : (
					editFields.map((f) => (
						<IntentFieldView
							key={f.key}
							field={f}
							editing={editing}
							onChange={(value) =>
								setDrafts((d) => ({
									...(d ?? Object.fromEntries(baseFields.map((b) => [b.key, b.value]))),
									[f.key]: value,
								}))
							}
						/>
					))
				)}
			</CardContent>
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t p-3">
				<div className="flex items-center gap-2">
					{editing ? (
						<>
							<Button
								size="sm"
								disabled={save.isPending}
								onClick={() => save.mutate(editFields)}
							>
								{save.isPending ? "Saving…" : "Save intent"}
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={save.isPending}
								onClick={() => setDrafts(null)}
							>
								Cancel
							</Button>
						</>
					) : (
						<Button
							size="sm"
							variant="outline"
							disabled={frozen || baseFields.length === 0}
							onClick={() =>
								setDrafts(Object.fromEntries(baseFields.map((b) => [b.key, b.value])))
							}
						>
							{frozen ? "Intent frozen" : "Edit intent"}
						</Button>
					)}
				</div>
				<SendOffButton
					conversation={conversation}
					intentNonEmpty={intentIsNonEmpty(baseFields)}
				/>
			</div>
			{save.isError ? (
				<p className="px-3 pb-2 text-xs text-(--color-destructive)">
					{formatError(save.error)}
				</p>
			) : null}
			{conversation.submittedPrUrl ? (
				<p className="px-3 pb-2 text-xs text-(--color-muted-foreground)">
					Sent to planner:{" "}
					<a
						href={conversation.submittedPrUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="font-semibold text-primary underline underline-offset-2 hover:text-primary/80"
					>
						PR #{conversation.submittedPrNumber || "link"} ↗
					</a>
				</p>
			) : null}
		</Card>
	);
}

function IntentFieldView({
	field,
	editing,
	onChange,
}: {
	field: IntentField;
	editing: boolean;
	onChange: (value: string) => void;
}): JSX.Element {
	return (
		<div className="space-y-1">
			<div className="text-xs font-medium text-(--color-muted-foreground)">
				{field.label}
				{field.kind === "list" ? " (one per line)" : ""}
			</div>
			{editing ? (
				<Textarea
					value={field.value}
					rows={field.kind === "list" ? 4 : 3}
					onChange={(e) => onChange(e.target.value)}
					aria-label={`Edit ${field.label}`}
				/>
			) : field.value.trim().length === 0 ? (
				<p className="text-sm text-(--color-muted-foreground)">—</p>
			) : field.kind === "list" ? (
				<ul className="list-disc space-y-0.5 pl-5 text-sm">
					{field.value
						.split("\n")
						.filter((line) => line.trim().length > 0)
						.map((line, i) => (
							<li key={`${field.key}-${i}`}>{line}</li>
						))}
				</ul>
			) : (
				<p className="whitespace-pre-wrap break-words text-sm">{field.value}</p>
			)}
		</div>
	);
}
