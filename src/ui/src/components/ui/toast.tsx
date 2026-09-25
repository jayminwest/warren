import * as ToastPrimitive from "@radix-ui/react-toast";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon, X } from "lucide-react";
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

/*
 * warren-9474: a toast is a raised surface, not a tinted box — it floats
 * over any page, so it needs its own ground. The icon carries the hue.
 * It pops in with the CSS `animate-pop-in` keyframe (no motion library).
 */
const toastVariants = cva(
	cn(
		"animate-pop-in group pointer-events-auto relative flex w-full items-start gap-2.5 overflow-hidden rounded-md border border-(--color-border-strong) bg-(--color-surface-raised) p-3 pr-9 text-sm text-(--color-text) shadow-lg",
		"data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-(--radix-toast-swipe-end-x)",
		"data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=move]:transition-none",
	),
	{
		variants: {
			variant: {
				info: "",
				success: "",
				warning: "",
				danger: "border-(--color-danger)/40",
				neutral: "",
			},
		},
		defaultVariants: { variant: "neutral" },
	},
);

const VARIANT_ICON: Record<
	NonNullable<VariantProps<typeof toastVariants>["variant"]>,
	LucideIcon
> = {
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	danger: AlertCircle,
	neutral: Info,
};

const VARIANT_ICON_TONE: Record<
	NonNullable<VariantProps<typeof toastVariants>["variant"]>,
	string
> = {
	info: "text-(--color-info)",
	success: "text-(--color-success)",
	warning: "text-(--color-warning)",
	danger: "text-(--color-danger)",
	neutral: "text-(--color-text-3)",
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

	const toast = React.useCallback((input: Omit<ToastItem, "id"> & { id?: string }): string => {
		const id = input.id ?? `t-${++toastSeq}`;
		setItems((prev) => [...prev.filter((i) => i.id !== id), { ...input, id }]);
		return id;
	}, []);
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
								className={cn("mt-0.5 size-4 shrink-0", VARIANT_ICON_TONE[v])}
							/>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								{it.title ? (
									<ToastPrimitive.Title className="font-medium">{it.title}</ToastPrimitive.Title>
								) : null}
								{it.description ? (
									<ToastPrimitive.Description className="break-words text-(--color-text-2)">
										{it.description}
									</ToastPrimitive.Description>
								) : null}
							</div>
							<ToastPrimitive.Close
								aria-label="Close"
								className="absolute top-2 right-2 inline-flex size-6 items-center justify-center rounded-sm text-(--color-text-3) transition-colors hover:bg-(--color-surface-hover) hover:text-(--color-text) focus-visible:ring-2 focus-visible:ring-(--color-primary)/40 focus-visible:outline-none"
							>
								<X className="size-3.5" />
							</ToastPrimitive.Close>
						</ToastPrimitive.Root>
					);
				})}
				<ToastPrimitive.Viewport
					className={cn(
						"fixed right-4 bottom-20 left-4 z-(--z-toast) ml-auto flex max-h-screen max-w-sm flex-col gap-2 outline-none sm:left-auto sm:w-full md:bottom-4",
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
