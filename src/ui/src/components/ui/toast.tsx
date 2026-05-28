import * as ToastPrimitive from "@radix-ui/react-toast";
import { cva, type VariantProps } from "class-variance-authority";
import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	Info,
	type LucideIcon,
	X,
} from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 4 shared-state primitive (warren-36f0 / pl-55a3 step 5):
 *
 * Toast — Radix-backed transient notification. Tied into a single
 * `<ToastProvider>` mounted at the app root (Layout.tsx) plus a
 * `useToast()` hook that exposes `toast(...)` for any descendant.
 * mx-d6ccf3 noted we had no toast library; this is the wire-up.
 *
 * Variants mirror Alert's status palette so the same hue family is used
 * for both inline and transient feedback. Viewport sits at z-(--z-toast)
 * (Phase 1 token, 50) in the bottom-right corner.
 */

const toastVariants = cva(
	cn(
		"group pointer-events-auto relative flex w-full items-start gap-2.5 overflow-hidden rounded-md border p-3 pr-8 shadow-lg",
		"text-sm",
		"data-[state=open]:animate-in data-[state=closed]:animate-out",
		"data-[state=closed]:fade-out-80 data-[state=open]:fade-in",
		"data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:slide-out-to-right-full",
		"data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-(--radix-toast-swipe-end-x)",
		"data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=move]:transition-none",
	),
	{
		variants: {
			variant: {
				info: "border-(--color-info)/30 bg-(--color-info)/10 text-(--color-info-foreground)",
				success:
					"border-(--color-success)/30 bg-(--color-success)/10 text-(--color-success-foreground)",
				warning:
					"border-(--color-warning)/30 bg-(--color-warning)/10 text-(--color-warning-foreground)",
				danger:
					"border-(--color-danger)/30 bg-(--color-danger)/10 text-(--color-danger-foreground)",
				neutral: "border-(--color-border) bg-(--color-card) text-(--color-fg)",
			},
		},
		defaultVariants: { variant: "neutral" },
	},
);

const VARIANT_ICON: Record<NonNullable<VariantProps<typeof toastVariants>["variant"]>, LucideIcon> = {
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	danger: AlertCircle,
	neutral: Info,
};

export type ToastVariant = NonNullable<VariantProps<typeof toastVariants>["variant"]>;

export interface ToastItem {
	id: string;
	title?: React.ReactNode;
	description?: React.ReactNode;
	variant?: ToastVariant;
	durationMs?: number;
}

interface ToastContextValue {
	toast: (input: Omit<ToastItem, "id"> & { id?: string }) => string;
	dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

let toastSeq = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
	const [items, setItems] = React.useState<ToastItem[]>([]);

	const toast = React.useCallback(
		(input: Omit<ToastItem, "id"> & { id?: string }): string => {
			const id = input.id ?? `t-${++toastSeq}`;
			setItems((prev) => [...prev.filter((i) => i.id !== id), { ...input, id }]);
			return id;
		},
		[],
	);
	const dismiss = React.useCallback((id: string) => {
		setItems((prev) => prev.filter((i) => i.id !== id));
	}, []);

	const value = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

	return (
		<ToastContext.Provider value={value}>
			<ToastPrimitive.Provider swipeDirection="right">
				{children}
				{items.map((it) => {
					const v = it.variant ?? "neutral";
					const Icon = VARIANT_ICON[v];
					return (
						<ToastPrimitive.Root
							key={it.id}
							duration={it.durationMs ?? 5000}
							onOpenChange={(open) => {
								if (!open) dismiss(it.id);
							}}
							className={cn(toastVariants({ variant: v }))}
						>
							<Icon
								aria-hidden="true"
								className="mt-0.5 h-4 w-4 shrink-0 text-(--color-fg)"
							/>
							<div className="min-w-0 flex-1 space-y-0.5">
								{it.title ? (
									<ToastPrimitive.Title className="font-medium leading-tight">
										{it.title}
									</ToastPrimitive.Title>
								) : null}
								{it.description ? (
									<ToastPrimitive.Description className="leading-snug">
										{it.description}
									</ToastPrimitive.Description>
								) : null}
							</div>
							<ToastPrimitive.Close
								aria-label="Close"
								className="absolute right-2 top-2 rounded-sm opacity-60 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-(--color-ring)"
							>
								<X className="h-3.5 w-3.5" />
							</ToastPrimitive.Close>
						</ToastPrimitive.Root>
					);
				})}
				<ToastPrimitive.Viewport
					className={cn(
						"fixed bottom-4 right-4 z-(--z-toast) flex max-h-screen w-full max-w-sm flex-col gap-2 outline-none",
					)}
				/>
			</ToastPrimitive.Provider>
		</ToastContext.Provider>
	);
}

export function useToast(): ToastContextValue {
	const ctx = React.useContext(ToastContext);
	if (!ctx) {
		throw new Error("useToast must be used inside <ToastProvider>");
	}
	return ctx;
}
