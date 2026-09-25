import type { ReactNode } from "react";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Form scaffolding shared by the two dispatch forms (warren-9474): the run
 * form here and the plan-run form under `../dispatch-plan/`. Page-local
 * until a third form needs it; then it moves to `components/ui/`.
 */

/**
 * One labelled control: label (plus an "Optional" marker), the control,
 * then either the error or a quiet hint under it. `htmlFor` names the
 * control's id; omit it for a control that labels itself (a Segmented
 * fieldset) and the label renders as plain text.
 */
export function Field({
	label,
	htmlFor,
	hint,
	error,
	optional = false,
	className,
	children,
}: {
	label: string;
	htmlFor?: string;
	hint?: ReactNode;
	error?: string | null;
	optional?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const labelClass = "text-xs font-medium text-(--color-text-2)";
	return (
		<div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
			<div className="flex items-baseline justify-between gap-2">
				{htmlFor !== undefined ? (
					<label htmlFor={htmlFor} className={labelClass}>
						{label}
					</label>
				) : (
					<span className={labelClass}>{label}</span>
				)}
				{optional ? <span className="text-2xs text-(--color-text-3)">Optional</span> : null}
			</div>
			{children}
			{error ? (
				<p role="alert" className="text-xs text-(--color-danger)">
					{error}
				</p>
			) : hint ? (
				<p className="text-xs text-(--color-text-3)">{hint}</p>
			) : null}
		</div>
	);
}

/** Two fields side by side from `sm` up; stacked on a phone (warren-3de0). */
export function FieldRow({ children }: { children: ReactNode }) {
	return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

/** A titled group of fields: one Card per concern, the same at every width. */
export function FormSection({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<Card className="w-full">
			<CardHeader title={title} meta={description} />
			<div className="flex flex-col gap-4 p-4">{children}</div>
		</Card>
	);
}

/** Red border for a control whose Field carries an error. */
export function invalidClass(error: string | null | undefined): string | undefined {
	return error ? "border-(--color-danger) focus-visible:border-(--color-danger)" : undefined;
}
