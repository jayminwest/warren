import * as React from "react";
import { cn } from "@/lib/utils.ts";
import { Label } from "./label.tsx";

/*
 * Phase 6 layout primitive (warren-e6b3 / pl-55a3 step 7):
 *
 * Field — wraps `<Label>` + control + optional description/error/hint
 * into the `space-y-1.5` stack that NewRun, NewPlanRun, ProjectDetail,
 * and the per-Plot form blocks all repeat by hand. Consolidating the
 * pattern means every form field gets:
 *   - the same vertical rhythm,
 *   - the same `text-xs text-(--color-muted-foreground)` hint copy,
 *   - the same `text-(--color-destructive)` error voice,
 *   - automatic `htmlFor`/`id` wiring + `aria-describedby` /
 *     `aria-invalid` on the rendered control via render-prop.
 *
 * Two usage shapes:
 *
 *   <Field label="Branch" htmlFor="ref" description="…">
 *     <Input id="ref" ... />
 *   </Field>
 *
 * or, for full aria wiring of a single control:
 *
 *   <Field label="Branch" id="ref" description="…" error={err}>
 *     {(ctl) => <Input {...ctl} value={ref} onChange={...} />}
 *   </Field>
 *
 * In the render-prop form, the child receives `id`, `aria-invalid`,
 * and `aria-describedby` props that point at the auto-generated
 * description / error nodes.
 */
export interface FieldControlProps {
	id: string;
	"aria-invalid"?: boolean;
	"aria-describedby"?: string;
}

export interface FieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
	label: React.ReactNode;
	/** id of the control. Used for htmlFor + aria wiring. */
	id?: string;
	/** legacy alias for `id`; pass either. */
	htmlFor?: string;
	description?: React.ReactNode;
	error?: React.ReactNode;
	required?: boolean;
	children: React.ReactNode | ((ctl: FieldControlProps) => React.ReactNode);
}

export const Field = React.forwardRef<HTMLDivElement, FieldProps>(
	(
		{
			className,
			label,
			id,
			htmlFor,
			description,
			error,
			required,
			children,
			...props
		},
		ref,
	) => {
		const controlId = id ?? htmlFor;
		const descId = description !== undefined && controlId ? `${controlId}-desc` : undefined;
		const errId = error !== undefined && error !== null && controlId
			? `${controlId}-err`
			: undefined;
		const describedBy = [descId, errId].filter(Boolean).join(" ") || undefined;
		const ctl: FieldControlProps = {
			id: controlId ?? "",
			"aria-invalid": error !== undefined && error !== null ? true : undefined,
			"aria-describedby": describedBy,
		};
		return (
			<div ref={ref} className={cn("space-y-1.5", className)} {...props}>
				{controlId ? (
					<Label htmlFor={controlId}>
						{label}
						{required ? (
							<span aria-hidden="true" className="ml-0.5 text-(--color-destructive)">
								*
							</span>
						) : null}
					</Label>
				) : (
					<span className="text-sm font-medium leading-none">{label}</span>
				)}
				{typeof children === "function" ? children(ctl) : children}
				{description !== undefined ? (
					<p id={descId} className="text-xs text-(--color-muted-foreground)">
						{description}
					</p>
				) : null}
				{error !== undefined && error !== null ? (
					<p id={errId} className="text-xs text-(--color-destructive)">
						{error}
					</p>
				) : null}
			</div>
		);
	},
);
Field.displayName = "Field";
