import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import type * as React from "react";
import { formatRunFailureReason } from "@/lib/labels.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The one status vocabulary (warren-9474). Every state the console shows —
 * run, plan run, plan-run child, preview, event stream — maps to a tone,
 * and a tone is the only thing that picks a colour. Colour carries meaning
 * and nothing else: blue is live, green succeeded, red failed, amber waits
 * on something, purple merged, gray is idle or finished without a result.
 */
export type Tone = "live" | "ok" | "err" | "warn" | "merge" | "idle";

const TONE_TEXT: Record<Tone, string> = {
	live: "text-(--color-info)",
	ok: "text-(--color-success)",
	err: "text-(--color-danger)",
	warn: "text-(--color-warning)",
	merge: "text-(--color-merge)",
	idle: "text-(--color-text-3)",
};

const TONE_DOT: Record<Tone, string> = {
	live: "bg-(--color-info)",
	ok: "bg-(--color-success)",
	err: "bg-(--color-danger)",
	warn: "bg-(--color-warning)",
	merge: "bg-(--color-merge)",
	idle: "bg-(--color-text-3)",
};

const TONE_SOFT: Record<Tone, string> = {
	live: "bg-(--color-info)/12 text-(--color-info)",
	ok: "bg-(--color-success)/12 text-(--color-success)",
	err: "bg-(--color-danger)/12 text-(--color-danger)",
	warn: "bg-(--color-warning)/12 text-(--color-warning)",
	merge: "bg-(--color-merge)/12 text-(--color-merge)",
	idle: "bg-(--color-surface-hover) text-(--color-text-2)",
};

const STATE_TONES: Record<string, Tone> = {
	running: "live",
	dispatched: "live",
	starting: "live",
	connecting: "live",
	live: "live",
	queued: "warn",
	pending: "idle",
	pr_open: "warn",
	succeeded: "ok",
	ended: "ok",
	merged: "merge",
	failed: "err",
	error: "err",
	cancelled: "idle",
	skipped: "idle",
	"torn-down": "idle",
};

/** States that are still moving — their dot breathes. */
const LIVE_STATES = new Set(["running", "dispatched", "starting", "connecting", "live"]);

const STATE_LABELS: Record<string, string> = {
	queued: "Queued",
	running: "Running",
	succeeded: "Succeeded",
	failed: "Failed",
	cancelled: "Cancelled",
	pending: "Pending",
	dispatched: "Dispatched",
	pr_open: "PR open",
	merged: "Merged",
	skipped: "Skipped",
	starting: "Starting",
	live: "Live",
	"torn-down": "Torn down",
	connecting: "Connecting",
	ended: "Ended",
	error: "Error",
};

export function stateTone(state: string): Tone {
	return STATE_TONES[state] ?? "idle";
}

/** Sentence-case label for any wire state; unknown values humanize. */
export function stateLabel(state: string): string {
	const known = STATE_LABELS[state];
	if (known) return known;
	const spaced = state.replace(/[_-]+/g, " ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function toneText(tone: Tone): string {
	return TONE_TEXT[tone];
}

export function toneDot(tone: Tone): string {
	return TONE_DOT[tone];
}

const DOT_SIZES = { sm: "size-1.5", md: "size-2", lg: "size-2.5" } as const;

export function StatusDot({
	state,
	tone,
	size = "md",
	className,
}: {
	state?: string;
	tone?: Tone;
	size?: keyof typeof DOT_SIZES;
	className?: string;
}) {
	const t = tone ?? stateTone(state ?? "");
	const isLive = state !== undefined && LIVE_STATES.has(state);
	return (
		<span
			aria-hidden
			className={cn(
				"relative inline-block shrink-0 rounded-full",
				DOT_SIZES[size],
				TONE_DOT[t],
				TONE_TEXT[t],
				isLive && "animate-pulse-ring",
				className,
			)}
		/>
	);
}

/**
 * Soft pill: dot + sentence-case label. A failed run passes its
 * `failureReason` and the pill reads the reason instead of "Failed"; the
 * raw state rides in the tooltip. `label` overrides both.
 */
export function StatusBadge({
	state,
	reason,
	label,
	tone,
	className,
}: {
	state: string;
	reason?: string | null;
	label?: React.ReactNode;
	tone?: Tone;
	className?: string;
}) {
	const t = tone ?? stateTone(state);
	const text =
		label ?? (state === "failed" && reason ? formatRunFailureReason(reason) : stateLabel(state));
	return (
		<span
			title={reason ? `${state} · ${reason}` : state}
			className={cn(
				"inline-flex h-5.5 max-w-full items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap",
				TONE_SOFT[t],
				className,
			)}
		>
			<StatusDot state={state} tone={t} size="sm" />
			<span className="truncate">{text}</span>
		</span>
	);
}

/** Bare inline status: dot + label, no fill — for dense table cells. */
export function StatusText({
	state,
	reason,
	className,
}: {
	state: string;
	reason?: string | null;
	className?: string;
}) {
	const t = stateTone(state);
	return (
		<span
			title={reason ? `${state} · ${reason}` : state}
			className={cn("inline-flex min-w-0 items-center gap-2 text-sm", TONE_TEXT[t], className)}
		>
			<StatusDot state={state} tone={t} size="sm" />
			<span className="truncate">
				{state === "failed" && reason ? formatRunFailureReason(reason) : stateLabel(state)}
			</span>
		</span>
	);
}

export function prTone(lifecycle: string | null | undefined): Tone {
	if (lifecycle === "merged") return "merge";
	if (lifecycle === "open") return "ok";
	if (lifecycle === "closed_unmerged") return "err";
	return "idle";
}

/** `#1234` from a GitHub PR URL, or null. */
export function prNumber(url: string): string | null {
	const m = /\/pull\/(\d+)/.exec(url);
	return m ? `#${m[1]}` : null;
}

/**
 * PR chip: icon + number (+ lifecycle word unless `compact`), as an
 * anchor that opens the PR. Never place it inside another link — a row
 * that navigates should make its primary cell the link, not the row.
 */
export function PrChip({
	url,
	lifecycle,
	compact,
	className,
}: {
	url: string;
	lifecycle?: string | null;
	compact?: boolean;
	className?: string;
}) {
	const t = prTone(lifecycle);
	const num = prNumber(url) ?? "PR";
	const word =
		lifecycle === "merged"
			? "Merged"
			: lifecycle === "open"
				? "Open"
				: lifecycle === "closed_unmerged"
					? "Closed"
					: "Opened";
	const Icon =
		lifecycle === "merged"
			? GitMerge
			: lifecycle === "closed_unmerged"
				? GitPullRequestClosed
				: GitPullRequest;
	const cls = cn(
		"inline-flex h-5.5 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium whitespace-nowrap transition-colors",
		t === "idle"
			? "border-(--color-border) text-(--color-text-2) hover:border-(--color-border-strong)"
			: cn("border-current/25 hover:border-current/50", TONE_TEXT[t]),
		className,
	);
	const body = (
		<>
			<Icon aria-hidden className="size-3.5" />
			<span className="tabular-nums">{num}</span>
			{compact ? null : <span className="font-normal opacity-80">{word}</span>}
		</>
	);
	const title = `Pull request ${num} · ${word}`;
	return (
		<a href={url} target="_blank" rel="noreferrer" title={title} className={cls}>
			{body}
		</a>
	);
}
