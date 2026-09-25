import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 4 shared-state primitive (warren-36f0 / pl-55a3 step 5):
 *
 * Alert / Callout — a tinted box used for inline error, success,
 * warning, info, and neutral states. Backed by the semantic status
 * palette tokens added in Phase 1 (--color-success / -warning / -info /
 * -danger / -neutral) and their -foreground pairs added in this phase.
 * Pattern mirrors Badge's cva variants so the token surface stays
 * predictable.
 *
 * Sizing/spacing follows the existing inline-error idiom across the UI
 * (rounded-md border, p-3, text-sm). The variant fill is a faint tint of
 * the status colour and the icon carries the hue; title and body stay on
 * the text tokens so they read in both themes (warren-9474). Icon is auto-picked from the variant; pass `icon={null}` to
 * suppress or `icon={<MyIcon …/>}` to override.
 *
 * Variants:
 *   - `info`     (default) — blue Info circle
 *   - `success`  — green CheckCircle2
 *   - `warning`  — amber AlertTriangle
 *   - `danger`   — red AlertCircle
 *   - `neutral`  — gray Info circle (no semantic color)
 *
 * Role attribute is `alert` for `danger`/`warning` (assertive — screen
 * readers interrupt) and `status` for everything else (polite). Callers
 * can override via the standard `role` prop.
 */

const alertVariants = cva(
	"animate-fade-in relative flex w-full items-start gap-2.5 rounded-md border p-3 text-sm text-(--color-text)",
	{
		variants: {
			variant: {
				info: "border-(--color-info)/30 bg-(--color-info)/8",
				success: "border-(--color-success)/30 bg-(--color-success)/8",
				warning: "border-(--color-warning)/35 bg-(--color-warning)/8",
				danger: "border-(--color-danger)/35 bg-(--color-danger)/8",
				neutral: "border-(--color-border) bg-(--color-surface)",
			},
		},
		defaultVariants: { variant: "info" },
	},
);

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;

const VARIANT_ICON: Record<AlertVariant, LucideIcon> = {
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	danger: AlertCircle,
	neutral: Info,
};

/** The icon carries the hue; the text stays on the readable ink in both themes. */
const VARIANT_ICON_TONE: Record<AlertVariant, string> = {
	info: "text-(--color-info)",
	success: "text-(--color-success)",
	warning: "text-(--color-warning)",
	danger: "text-(--color-danger)",
	neutral: "text-(--color-text-3)",
};

export interface AlertProps
	extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
		VariantProps<typeof alertVariants> {
	title?: React.ReactNode;
	/** Icon override. Pass `null` to suppress the auto-selected icon. */
	icon?: React.ReactNode | null;
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
	({ className, variant, title, icon, role, children, ...props }, ref) => {
		const v = variant ?? "info";
		const Auto = VARIANT_ICON[v];
		const renderIcon =
			icon === undefined ? (
				<Auto aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", VARIANT_ICON_TONE[v])} />
			) : icon === null ? null : (
				<span className="mt-0.5 shrink-0">{icon}</span>
			);
		const resolvedRole = role ?? (v === "danger" || v === "warning" ? "alert" : "status");
		return (
			<div
				ref={ref}
				role={resolvedRole}
				className={cn(alertVariants({ variant: v }), className)}
				{...props}
			>
				{renderIcon}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					{title ? <div className="font-medium text-(--color-text)">{title}</div> : null}
					{children ? <div className="text-(--color-text-2)">{children}</div> : null}
				</div>
			</div>
		);
	},
);
Alert.displayName = "Alert";

export { alertVariants };
