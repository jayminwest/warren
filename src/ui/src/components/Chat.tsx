/**
 * Interactive chat surface (pl-0344 step 10 / warren-ea98).
 *
 * Renders the streaming message list (user + agent bubbles) for an
 * interactive run, plus an input + send affordance. Consumes
 * `useEventStream(runId, follow)` so the agent's reply lights up live
 * via the same NDJSON pipe every other live surface in the UI rides on
 * (`/runs/:id/events`, mx-84aa73).
 *
 * Reusable across brainstorm (warren-3de8) and planner (warren-543d)
 * agents and any future interactive surface — the only knob the caller
 * has to provide is the conversation handle (`runId`) and, optionally,
 * a `header` slot for context-specific UI (Plot name, agent badge…).
 *
 * Wire shapes:
 *   - User turn  → event kind `user_message`  with payload `{actor, content}`
 *   - Agent turn → event kind `agent_message` with payload `{actor, content}`
 *
 * Sending a message calls `POST /runs/:id/messages`; the conversation
 * handle (`runId`) is forwarded to the new turn's run id via
 * `onTurnSpawned` so the parent surface (PlotDetail in warren-444c) can
 * re-anchor its event stream onto the latest turn. The default behavior
 * — when `onTurnSpawned` is not provided — is to render messages from
 * the conversation handle the parent supplied and not re-anchor; the
 * server appends both user_message and (later) agent_message onto the
 * spawned turn's run id, so a parent that wants to follow the live
 * agent reply must rebind its stream.
 *
 * Non-goals here: persisting draft text, optimistic user-bubble render
 * (the server-appended user_message lands fast enough), question_posed
 * surfacing (lives in PlotDetail's activity feed per warren-4ea4), or
 * formalize-summary rendering (warren-d22e / PlotDetail).
 */

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { runsApi } from "@/api/client.ts";
import type { MessageRow } from "@/api/types.ts";
import {
	buildChatMessages,
	type ChatMessage,
} from "@/components/chat-messages.ts";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { useEventStream } from "@/hooks/useEventStream.ts";
import { formatError } from "@/lib/format-error.ts";
import { cn, formatTimestamp } from "@/lib/utils.ts";

export interface ChatProps {
	/**
	 * Conversation handle — any interactive run row that shares the
	 * conversation's plotId works. Defaults to following live events
	 * until the run terminates; `follow={false}` (e.g. for a closed
	 * conversation transcript) replays history once and stops.
	 */
	readonly runId: string;
	readonly follow?: boolean;
	/**
	 * Already-fetched persisted transcript (e.g.
	 * `GET /conversations/:id` → `messages`). Rendered merged with the
	 * live event stream so the conversation shows its history regardless
	 * of run state — including when the anchoring run died before
	 * emitting any events (warren-9929 / pl-de53). `user` rows map to
	 * user bubbles and `assistant` rows to agent bubbles; `system` /
	 * `tool` rows are omitted. Rows whose (kind, content) match a
	 * streamed event are deduped so an active conversation does not
	 * double-render turns that appear in both the transcript and the
	 * stream.
	 */
	readonly transcript?: readonly MessageRow[];
	/** Disable the input row (e.g. while the parent is mid-dispatch). */
	readonly disabled?: boolean;
	/** Placeholder for the input box. */
	readonly placeholder?: string;
	/** Optional header slot rendered above the message list. */
	readonly header?: React.ReactNode;
	/**
	 * Fired after `POST /runs/:id/messages` succeeds with the new turn's
	 * run id. Parents that want to re-anchor their event stream onto the
	 * fresh turn pass a handler; otherwise the chat continues streaming
	 * from the original `runId` (the user_message lands on the new
	 * turn's id, so the original stream won't see it without a parent
	 * re-anchor).
	 */
	readonly onTurnSpawned?: (turnRunId: string) => void;
	/**
	 * Override the default `POST /runs/:id/messages` send path. When
	 * provided, the chat calls this instead — used by the Leveret
	 * conversation split-view (warren-01c8), which delivers turns over
	 * `POST /conversations/:id/messages` (persist + steer the long-lived
	 * anchoring run) and keeps its stream anchored on `runId` rather than
	 * re-anchoring onto a fresh turn. Resolves when the turn is accepted.
	 */
	readonly sendMessage?: (message: string) => Promise<void>;
	/** Optional className passthrough for the outer wrapper. */
	readonly className?: string;
}

export function Chat({
	runId,
	follow = true,
	transcript,
	disabled = false,
	placeholder = "Type a message…",
	header,
	onTurnSpawned,
	sendMessage,
	className,
}: ChatProps): JSX.Element {
	const { events, status, error } = useEventStream(runId, follow);
	const messages = useMemo(
		() => buildChatMessages(transcript, events),
		[transcript, events],
	);

	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);

	// Auto-scroll the transcript to the bottom on new messages.
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = listRef.current;
		if (el === null) return;
		el.scrollTop = el.scrollHeight;
	}, [messages.length]);

	const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
		e.preventDefault();
		const trimmed = draft.trim();
		if (trimmed.length === 0 || sending || disabled) return;
		setSending(true);
		setSendError(null);
		try {
			if (sendMessage) {
				await sendMessage(trimmed);
				setDraft("");
			} else {
				const res = await runsApi.sendMessage(runId, { message: trimmed });
				setDraft("");
				if (onTurnSpawned) onTurnSpawned(res.run.id);
			}
		} catch (err) {
			setSendError(formatError(err));
		} finally {
			setSending(false);
		}
	};

	const inputDisabled = disabled || sending;

	return (
		<div className={cn("flex h-full flex-col gap-3", className)}>
			{header !== undefined ? <div className="shrink-0">{header}</div> : null}
			<div
				ref={listRef}
				className={cn(
					"flex-1 min-h-0 overflow-y-auto rounded-md border bg-(--color-card) p-3",
					"flex flex-col gap-2",
				)}
				aria-live="polite"
				aria-label="Chat transcript"
			>
				{messages.length === 0 ? (
					<div className="m-auto text-sm text-(--color-muted-foreground)">
						{status === "connecting" ? "Connecting…" : "No messages yet."}
					</div>
				) : (
					messages.map((m) => <Bubble key={m.id} message={m} />)
				)}
			</div>
			{error !== null ? (
				<div className="shrink-0 text-xs text-(--color-destructive)">
					Stream error: {error}
				</div>
			) : null}
			<form onSubmit={onSubmit} className="shrink-0 flex flex-col gap-2">
				<Textarea
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder={placeholder}
					disabled={inputDisabled}
					rows={3}
					onKeyDown={(e) => {
						// Cmd/Ctrl+Enter to send.
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							(e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
						}
					}}
					aria-label="Message input"
				/>
				<div className="flex items-center justify-between gap-2">
					<span className="text-xs text-(--color-muted-foreground)">
						{sendError !== null
							? sendError
							: "Cmd/Ctrl+Enter to send"}
					</span>
					<Button
						type="submit"
						disabled={inputDisabled || draft.trim().length === 0}
					>
						{sending ? "Sending…" : "Send"}
					</Button>
				</div>
			</form>
		</div>
	);
}

interface BubbleProps {
	readonly message: ChatMessage;
}

function Bubble({ message }: BubbleProps): JSX.Element {
	const isUser = message.kind === "user";
	return (
		<div
			className={cn(
				"flex flex-col gap-1 max-w-[85%]",
				isUser ? "self-end items-end" : "self-start items-start",
			)}
		>
			<div className="text-xs text-(--color-muted-foreground)">
				<span>{message.actor}</span>
				<span> · </span>
				<span>{formatTimestamp(message.ts)}</span>
			</div>
			<div
				className={cn(
					"rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words",
					isUser
						? "bg-(--color-primary) text-(--color-primary-foreground)"
						: "border bg-(--color-card) text-(--color-fg)",
				)}
			>
				{message.content}
			</div>
		</div>
	);
}
