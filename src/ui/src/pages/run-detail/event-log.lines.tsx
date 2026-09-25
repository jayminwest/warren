import {
	Braces,
	Brain,
	ChevronRight,
	CircleAlert,
	GitBranch,
	GitMerge,
	GitPullRequest,
	MessageSquare,
	Send,
	Terminal,
	Wrench,
} from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils.ts";
import { formatWallClock } from "@/pages/run-detail-format.ts";
import type { LogLine } from "./event-log-classify.ts";

/**
 * One memoized component per log line kind (warren-4a47). A line is
 * `[time][icon][content]`; every line can reveal its raw payload from a
 * hover affordance, so the classified view never hides the evidence.
 * Lines are keyed by event id and memoized on the (cached, stable)
 * LogLine object, so appending events never re-renders old lines.
 */

const ROW = "group/line relative flex gap-3 px-4 py-0.5 hover:bg-(--color-surface-hover)";
const THINKING_CLAMP = 240;
const RESULT_LINES = 6;
const RESULT_CHARS = 600;

function Time({ ts }: { ts: string }) {
	return (
		<span className="w-14 shrink-0 pt-px text-right font-mono text-2xs text-(--color-text-3) tabular-nums select-none">
			{formatWallClock(ts)}
		</span>
	);
}

function Icon({ children }: { children?: ReactNode }) {
	return (
		<span className="flex h-5 w-4 shrink-0 items-center justify-center [&_svg]:size-3.5">
			{children}
		</span>
	);
}

function RawToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-pressed={open}
			title={open ? "Hide raw event" : "Show raw event"}
			className={cn(
				"absolute top-0.5 right-2 inline-flex size-5 items-center justify-center rounded-xs text-(--color-text-3) hover:bg-(--color-surface-raised) hover:text-(--color-text) focus-visible:opacity-100",
				open ? "opacity-100" : "opacity-0 group-hover/line:opacity-100",
			)}
		>
			<Braces aria-hidden className="size-3.5" />
		</button>
	);
}

function RawPayload({ line }: { line: LogLine }) {
	const { event } = line;
	const raw =
		typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload, null, 2);
	return (
		<div className="pr-4 pb-2 pl-28">
			<div className="mb-1 font-mono text-2xs text-(--color-text-3)">
				#{event.seq} · {event.kind}
				{event.stream !== null ? ` · ${event.stream}` : ""}
			</div>
			<pre className="max-h-96 overflow-auto rounded-sm border border-(--color-border) bg-(--color-bg) p-2.5 font-mono text-2xs break-words whitespace-pre-wrap text-(--color-text-2)">
				{raw}
			</pre>
		</div>
	);
}

function MessageBody({ line }: { line: LogLine }) {
	return (
		<div className="min-w-0 flex-1 py-1 text-sm break-words whitespace-pre-wrap text-(--color-text)">
			{line.body}
		</div>
	);
}

function ThinkingBody({ line }: { line: LogLine }) {
	const [open, setOpen] = useState(false);
	const text = line.body ?? "";
	const long = text.length > THINKING_CLAMP;
	return (
		<button
			type="button"
			onClick={() => setOpen((o) => !o)}
			disabled={!long}
			className="min-w-0 flex-1 text-left text-xs break-words whitespace-pre-wrap text-(--color-text-3) italic disabled:cursor-text"
		>
			{long && !open ? `${text.slice(0, THINKING_CLAMP)}…` : text}
		</button>
	);
}

function ToolBody({ line }: { line: LogLine }) {
	return (
		<div className="min-w-0 flex-1 pt-0.5">
			<span className="mr-2 inline-flex h-4.5 items-center rounded-xs bg-(--color-info)/12 px-1.5 font-mono text-2xs font-medium text-(--color-info)">
				{line.title}
			</span>
			<span className="font-mono text-xs break-all whitespace-pre-wrap text-(--color-text)">
				{line.body}
			</span>
		</div>
	);
}

function ResultBody({ line }: { line: LogLine }) {
	const [open, setOpen] = useState(false);
	const text = line.body ?? "";
	const rows = text.split("\n");
	const long = rows.length > RESULT_LINES || text.length > RESULT_CHARS;
	const shown =
		open || !long ? text : rows.slice(0, RESULT_LINES).join("\n").slice(0, RESULT_CHARS);
	return (
		<div
			className={cn(
				"min-w-0 flex-1 border-l-2 pl-3 font-mono text-2xs",
				line.isError
					? "border-(--color-danger)/60 text-(--color-danger)"
					: "border-(--color-border-strong) text-(--color-text-3)",
			)}
		>
			<div className="break-all whitespace-pre-wrap">
				{shown || <span className="text-(--color-text-3) italic">No output</span>}
			</div>
			{long ? (
				<button
					type="button"
					onClick={() => setOpen((o) => !o)}
					className="mt-0.5 inline-flex items-center gap-1 font-sans text-xs text-(--color-text-3) hover:text-(--color-text-2)"
				>
					<ChevronRight
						aria-hidden
						className={cn("size-3 transition-transform", open && "rotate-90")}
					/>
					{open ? "Collapse" : `Show all ${rows.length} lines`}
				</button>
			) : null}
		</div>
	);
}

function milestoneIcon(kind: string): ReactNode {
	if (kind === "reap.pr_opened") return <GitPullRequest className="text-(--color-success)" />;
	if (kind === "reap.branch_pushed") return <GitBranch className="text-(--color-primary)" />;
	if (kind === "seeds.seed_id_closed") return <GitMerge className="text-(--color-merge)" />;
	return <span className="size-1.5 rounded-full bg-(--color-text-3)" />;
}

function MilestoneBody({ line }: { line: LogLine }) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-3 py-1">
			<span
				className={cn(
					"shrink-0 text-sm font-medium",
					line.isError ? "text-(--color-danger)" : "text-(--color-text)",
				)}
			>
				{line.title}
			</span>
			{line.body !== null ? (
				<span
					className="min-w-0 truncate font-mono text-xs text-(--color-text-3)"
					title={line.body}
				>
					{line.body}
				</span>
			) : null}
			<span aria-hidden className="h-px min-w-6 flex-1 bg-(--color-border)" />
		</div>
	);
}

function WarningBody({ line }: { line: LogLine }) {
	return (
		<div
			className={cn(
				"min-w-0 flex-1 py-0.5 text-xs",
				line.isError ? "text-(--color-danger)" : "text-(--color-warning)",
			)}
		>
			<span className="mr-2 font-medium">{line.title}</span>
			<span className="font-mono text-2xs break-words whitespace-pre-wrap">{line.body}</span>
		</div>
	);
}

function SteerBody({ line }: { line: LogLine }) {
	return (
		<div className="my-1 min-w-0 flex-1 rounded-sm border border-(--color-warning)/30 bg-(--color-warning)/10 px-2.5 py-1.5 text-sm text-(--color-text)">
			<div className="mb-0.5 text-xs font-medium text-(--color-warning)">Steering message</div>
			<div className="break-words whitespace-pre-wrap">{line.body}</div>
		</div>
	);
}

function NoiseBody({ line }: { line: LogLine }) {
	const body = line.body ?? "";
	return (
		<div className="min-w-0 flex-1 truncate pt-0.5 font-mono text-2xs text-(--color-text-3)">
			<span className="mr-2 text-(--color-text-2)">{line.title}</span>
			{body.length > 300 ? `${body.slice(0, 300)}…` : body}
		</div>
	);
}

function lineIcon(line: LogLine): ReactNode {
	switch (line.kind) {
		case "message":
			return <MessageSquare className="text-(--color-primary)" />;
		case "thinking":
			return <Brain className="text-(--color-text-3)" />;
		case "tool":
			return line.tool === "bash" || line.tool === "Bash" ? (
				<Terminal className="text-(--color-info)" />
			) : (
				<Wrench className="text-(--color-info)" />
			);
		case "milestone":
			return milestoneIcon(line.event.kind);
		case "warning":
			return (
				<CircleAlert
					className={line.isError ? "text-(--color-danger)" : "text-(--color-warning)"}
				/>
			);
		case "steer":
			return <Send className="text-(--color-warning)" />;
		default:
			return null;
	}
}

function LineBody({ line }: { line: LogLine }) {
	switch (line.kind) {
		case "message":
			return <MessageBody line={line} />;
		case "thinking":
			return <ThinkingBody line={line} />;
		case "tool":
			return <ToolBody line={line} />;
		case "result":
			return <ResultBody line={line} />;
		case "milestone":
			return <MilestoneBody line={line} />;
		case "warning":
			return <WarningBody line={line} />;
		case "steer":
			return <SteerBody line={line} />;
		default:
			return <NoiseBody line={line} />;
	}
}

export const LogLineRow = memo(function LogLineRow({ line }: { line: LogLine }) {
	const [raw, setRaw] = useState(false);
	return (
		<div>
			<div
				className={cn(ROW, line.kind === "tool" && "mt-1.5", line.kind === "milestone" && "my-1")}
			>
				<Time ts={line.event.ts} />
				<Icon>{lineIcon(line)}</Icon>
				<LineBody line={line} />
				<RawToggle open={raw} onToggle={() => setRaw((r) => !r)} />
			</div>
			{raw ? <RawPayload line={line} /> : null}
		</div>
	);
});
