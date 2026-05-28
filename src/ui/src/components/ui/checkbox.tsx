import { Check } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 2b primitive (warren-57d7 / pl-55a3 step 3):
 *
 * `Checkbox` is a styled native <input type="checkbox"> wrapped with a
 * decorative `<Check>` glyph in a sibling span — the native input is
 * `appearance-none` so the checkmark is painted by the lucide icon when
 * `peer-checked` matches. This keeps form semantics, label-for hookup,
 * keyboard (Space) and form-data behavior intact without pulling in
 * @radix-ui/react-checkbox (kept off the dep tree under the pl-55a3
 * bundle ratchet).
 *
 * Callers pass standard <input> props (checked / defaultChecked /
 * onChange / disabled / name / id / aria-*). Indeterminate state is
 * exposed via the `indeterminate` prop and applied imperatively to the
 * underlying element via a merged ref. Phase 3+ will replace the two
 * raw `<input type="checkbox">` sites (RunDetail.tsx, Runs.tsx) with
 * this primitive.
 */
export interface CheckboxProps
	extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
	indeterminate?: boolean;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
	({ className, indeterminate, ...props }, forwardedRef) => {
		const innerRef = React.useRef<HTMLInputElement | null>(null);
		React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLInputElement);
		React.useEffect(() => {
			if (innerRef.current) {
				innerRef.current.indeterminate = Boolean(indeterminate);
			}
		}, [indeterminate]);
		return (
			<span className={cn("relative inline-flex h-4 w-4 shrink-0 align-middle", className)}>
				<input
					ref={innerRef}
					type="checkbox"
					className={cn(
						"peer h-4 w-4 cursor-pointer appearance-none rounded-sm border bg-(--color-card) shadow-xs",
						"checked:border-(--color-primary) checked:bg-(--color-primary)",
						"indeterminate:border-(--color-primary) indeterminate:bg-(--color-primary)",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring)",
						"disabled:cursor-not-allowed disabled:opacity-50",
					)}
					{...props}
				/>
				<Check
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute inset-0 m-auto h-3 w-3",
						"text-(--color-primary-foreground)",
						"opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-0",
					)}
				/>
			</span>
		);
	},
);
Checkbox.displayName = "Checkbox";
