import { AlertCircle, AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

/**
 * A readable problem callout for the detail pages: a danger- or warning-tinted box
 * whose title and body use the ordinary text tokens, so it reads in both
 * themes. (The shared Alert's danger variant sets its text from
 * `--color-danger-ink` / `--color-warning-ink`, text-on-solid-fill tokens
 * with no dark value, and renders dark red on dark red.)
 */
const TONES = {
	danger: {
		box: "border-(--color-danger)/35 bg-(--color-danger)/8",
		icon: "text-(--color-danger)",
		Icon: AlertCircle,
	},
	warning: {
		box: "border-(--color-warning)/35 bg-(--color-warning)/8",
		icon: "text-(--color-warning)",
		Icon: AlertTriangle,
	},
} as const;

export function ProblemNote({
	title,
	tone = "danger",
	children,
	action,
}: {
	title: string;
	tone?: keyof typeof TONES;
	children?: ReactNode;
	action?: ReactNode;
}) {
	const t = TONES[tone];
	return (
		<div
			role="alert"
			className={cn("flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm", t.box)}
		>
			<t.Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", t.icon)} />
			<div className="flex min-w-0 flex-col items-start gap-1">
				<p className="font-medium text-(--color-text)">{title}</p>
				{children !== undefined ? <div className="text-(--color-text-2)">{children}</div> : null}
				{action !== undefined ? <div className="mt-1.5">{action}</div> : null}
			</div>
		</div>
	);
}
