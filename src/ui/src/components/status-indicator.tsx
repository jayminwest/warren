/**
 * Unified status indicator registry — warren-3849 / pl-55a3 step 3.
 *
 * One source of truth maps every status string the UI shows
 * (`RunState`, `PreviewState`, `PlanRunState`, `PlanRunChildState`,
 * and RunDetail's event-stream status) to a single
 * `StatusMeta` record: `{ label, variant, icon, pulse }`. The
 * concrete rendering — a `Badge` with optional leading icon and an
 * optional `motion-safe:animate-pulse` hint — is centralised in
 * `<StatusIndicator>` (the old wrappers — `StateBadge`,
 * `PlanRunStateBadge`, `PlanRunChildStateBadge` — were removed with
 * the legacy pages in the pl-7e38 teardown, warren-7396).
 *
 * `<RunFailureBadge>` at the bottom is the same idea for the OTHER
 * enum a run row carries — its `failureReason`. It lives here rather
 * than in the page so the "prose for the visitor, raw value in the
 * tooltip" rule has one owner too (warren-14fc / #641).
 */
import {
	Activity,
	CheckCircle2,
	CircleDashed,
	Clock,
	GitPullRequest,
	type LucideIcon,
	MinusCircle,
	PlayCircle,
	PowerOff,
	XCircle,
} from "lucide-react";
import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { formatRunFailureReason, humanizeWireValue } from "@/lib/labels.ts";
import { cn } from "@/lib/utils.ts";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

/**
 * The visible/colour/icon metadata for a single status. `pulse`
 * applies a `motion-safe:animate-pulse` class to the icon so
 * in-flight states (running, starting, connecting) gently throb
 * without spinning, matching the rest of the design-system motion
 * layer.
 */
export interface StatusMeta {
	label: string;
	variant: BadgeVariant;
	icon: LucideIcon;
	pulse: boolean;
}

/**
 * Registry of status kinds. Each kind is its own keyed map so the
 * type system catches missing entries when the source union
 * changes. The values intentionally re-use the same `StatusMeta`
 * shape across kinds — that is the whole point.
 */
const RUN_STATUS: Record<string, StatusMeta> = {
	queued: { label: "queued", variant: "queued", icon: Clock, pulse: false },
	running: { label: "running", variant: "running", icon: Activity, pulse: true },
	succeeded: { label: "succeeded", variant: "succeeded", icon: CheckCircle2, pulse: false },
	failed: { label: "failed", variant: "failed", icon: XCircle, pulse: false },
	cancelled: { label: "cancelled", variant: "cancelled", icon: MinusCircle, pulse: false },
};

const PLAN_RUN_STATUS: Record<string, StatusMeta> = {
	queued: { label: "queued", variant: "queued", icon: Clock, pulse: false },
	running: { label: "running", variant: "running", icon: Activity, pulse: true },
	succeeded: { label: "succeeded", variant: "succeeded", icon: CheckCircle2, pulse: false },
	failed: { label: "failed", variant: "failed", icon: XCircle, pulse: false },
	cancelled: { label: "cancelled", variant: "cancelled", icon: MinusCircle, pulse: false },
};

const PLAN_RUN_CHILD_STATUS: Record<string, StatusMeta> = {
	pending: { label: "pending", variant: "secondary", icon: CircleDashed, pulse: false },
	dispatched: { label: "dispatched", variant: "queued", icon: PlayCircle, pulse: false },
	running: { label: "running", variant: "running", icon: Activity, pulse: true },
	// The one status whose wire value is not already a readable word
	// (warren-14fc / #641) — a public visitor should not be shown `pr_open`.
	pr_open: { label: "PR open", variant: "queued", icon: GitPullRequest, pulse: false },
	merged: { label: "merged", variant: "succeeded", icon: CheckCircle2, pulse: false },
	failed: { label: "failed", variant: "failed", icon: XCircle, pulse: false },
	skipped: { label: "skipped", variant: "cancelled", icon: MinusCircle, pulse: false },
};

const PREVIEW_STATUS: Record<string, StatusMeta> = {
	starting: { label: "starting", variant: "queued", icon: Clock, pulse: true },
	live: { label: "live", variant: "succeeded", icon: Activity, pulse: true },
	failed: { label: "failed", variant: "failed", icon: XCircle, pulse: false },
	"torn-down": { label: "torn-down", variant: "cancelled", icon: PowerOff, pulse: false },
};

/**
 * Event-stream connection status shown in `RunDetail`'s EventTail
 * card. Distinct from `RunState` because the labels and
 * colour mapping describe the SSE socket, not the run itself.
 */
const EVENT_STREAM_STATUS: Record<string, StatusMeta> = {
	connecting: { label: "connecting", variant: "queued", icon: Clock, pulse: true },
	live: { label: "live", variant: "running", icon: Activity, pulse: true },
	ended: { label: "ended", variant: "succeeded", icon: CheckCircle2, pulse: false },
	error: { label: "error", variant: "failed", icon: XCircle, pulse: false },
};

const REGISTRY = {
	run: RUN_STATUS,
	planRun: PLAN_RUN_STATUS,
	planRunChild: PLAN_RUN_CHILD_STATUS,
	preview: PREVIEW_STATUS,
	eventStream: EVENT_STREAM_STATUS,
} as const;

export type StatusKind = keyof typeof REGISTRY;

const SECONDARY_META: StatusMeta = {
	label: "unknown",
	variant: "secondary",
	icon: CircleDashed,
	pulse: false,
};

/**
 * Look up the `StatusMeta` for a `(kind, status)` pair. Returns a
 * `secondary` fallback when the kind or status is unknown so the UI
 * keeps rendering something useful instead of crashing. The unknown
 * status is humanized rather than printed raw — the dashboard is
 * public, so a status this registry has not caught up with must still
 * not reach a visitor as `some_new_state` (warren-14fc / #641).
 */
export function getStatusMeta(kind: StatusKind, status: string): StatusMeta {
	const entry = REGISTRY[kind][status];
	if (entry !== undefined) return entry;
	return { ...SECONDARY_META, label: humanizeWireValue(status) };
}

export interface StatusIndicatorProps {
	kind: StatusKind;
	status: string;
	/** Render the leading icon. Default `true`. */
	showIcon?: boolean;
	/** Render the textual label. Default `true`. */
	showLabel?: boolean;
	/** Override the label (defaults to `meta.label`). */
	label?: string;
	className?: string;
	title?: string;
}

/**
 * Render a status pill. Delegates colour + label + icon + pulse
 * lookup to the registry; callers pass only `(kind, status)` and
 * optional visual overrides.
 */
export function StatusIndicator({
	kind,
	status,
	showIcon = true,
	showLabel = true,
	label,
	className,
	title,
}: StatusIndicatorProps) {
	const meta = getStatusMeta(kind, status);
	const Icon = meta.icon;
	return (
		<Badge
			variant={meta.variant}
			className={cn("gap-1 font-mono text-xs", className)}
			title={title}
		>
			{showIcon ? (
				<Icon
					aria-hidden="true"
					className={cn("h-3 w-3 shrink-0", meta.pulse ? "motion-safe:animate-pulse" : undefined)}
				/>
			) : null}
			{showLabel ? <span>{label ?? meta.label}</span> : null}
		</Badge>
	);
}

/**
 * A failed run's `failureReason` as a pill. The label is prose so a
 * public visitor is never shown `finalize_failed`; the raw
 * discriminator stays in the tooltip so an operator can still read
 * exactly what the server recorded.
 */
export function RunFailureBadge({ reason }: { reason: string }) {
	return (
		<Badge variant="cancelled" className="text-xs" title={`Failure reason: ${reason}`}>
			{formatRunFailureReason(reason)}
		</Badge>
	);
}
