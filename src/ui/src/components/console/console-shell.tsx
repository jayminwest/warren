import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { ConsoleSidebar, ConsoleSidebarBody } from "@/components/console/console-sidebar.tsx";
import { ConsoleMobileStatusStrip, ConsoleTopbar } from "@/components/console/console-topbar.tsx";
import { type ConsoleStats, useConsoleStats } from "@/components/console/use-console-stats.ts";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import { Button } from "@/components/ui/button.tsx";
import { WarrenLogo } from "@/components/warren-logo.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The Direction C operator-console shell (warren-4ed7, pl-7e38 step 2):
 * fixed 224px sidebar + 42px status strip, with the routed page below.
 * Every later page issue mounts inside this shell via the Outlet.
 *
 * Below md the chrome splits into the mock's two phone bands (warren-3290,
 * docs/ui-revamp/screens/mobile/operations.jsx): a 48px brand bar (mark +
 * wordmark + environment/identity chip) and a standalone 34px status strip.
 */

/**
 * Environment/identity chip in the mobile brand bar (warren-3290). Same data
 * as the drawer's InstanceCard: access mode as the label, health as the dot.
 */
function MobileIdentityChip({ stats }: { stats: ConsoleStats }) {
	const caps = useCapabilities();
	const isOperator = caps.can("readOperator");
	return (
		<span className="flex shrink-0 items-center gap-1.5 rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) py-[5px] pr-2 pl-2">
			<span
				className={cn(
					"h-1.5 w-1.5 shrink-0 rounded-full",
					stats.health === "ok" && "bg-(--color-success)",
					stats.health === "down" && "bg-(--color-danger)",
					stats.health === "unknown" && "bg-(--color-text-3)",
				)}
				aria-hidden
			/>
			<span className="text-[11px] leading-[14px] font-medium text-(--color-text)">
				{isOperator ? "operator" : "read-only"}
			</span>
			<span className="text-[10px] leading-3 text-(--color-text-3)" aria-hidden>
				⌄
			</span>
		</span>
	);
}

export function ConsoleShell() {
	const stats = useConsoleStats();
	const location = useLocation();
	const [mobileNavOpen, setMobileNavOpen] = useState(false);

	// Close the drawer on route change so a mobile → desktop resize never
	// leaves a stale open flag (same pattern the legacy layout used).
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not a read
	useEffect(() => {
		setMobileNavOpen(false);
	}, [location.pathname]);

	return (
		<div className="flex h-dvh flex-col md:flex-row">
			<ConsoleSidebar stats={stats} />

			{/* Mobile header + main column. */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{/* Mobile chrome — visible only < md (warren-3290): the mock's two
				    stacked bands, a 48px brand bar then the 34px status strip. The
				    hamburger stays until the bottom-nav More tab lands (warren-4d4a). */}
				<div className="flex h-12 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-sidebar) px-3.5 md:hidden">
					<Button
						variant="ghost"
						size="sm"
						aria-label="Open navigation menu"
						aria-expanded={mobileNavOpen}
						onClick={() => setMobileNavOpen(true)}
						className="h-8 w-8 shrink-0 p-0"
					>
						<Menu className="h-4 w-4" />
					</Button>
					<WarrenLogo className="h-5 w-5 shrink-0" />
					<span className="text-[13px] leading-4 font-semibold tracking-[-0.02em] text-(--color-text)">
						warren
					</span>
					<span className="flex-1" />
					<MobileIdentityChip stats={stats} />
				</div>
				<div className="md:hidden">
					<ConsoleMobileStatusStrip stats={stats} />
				</div>

				{/* Desktop status strip. */}
				<div className="hidden md:block">
					<ConsoleTopbar stats={stats} />
				</div>

				<main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
					{/* Boundary sits INSIDE the chrome so a page-level throw costs
					    the page, not the shell (warren-1f12). */}
					<ErrorBoundary resetKey={location.pathname}>
						<Outlet />
					</ErrorBoundary>
				</main>
			</div>

			{/* Mobile slide-over drawer: same sidebar body as the desktop rail. */}
			<DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
				<DialogPrimitive.Portal>
					<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm md:hidden" />
					<DialogPrimitive.Content
						aria-label="Navigation"
						className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-(--color-border) bg-(--color-sidebar) shadow-lg md:hidden"
					>
						<DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
						<div className="relative">
							<ConsoleSidebarBody stats={stats} onNavigate={() => setMobileNavOpen(false)} />
						</div>
						<DialogPrimitive.Close asChild>
							<Button
								variant="ghost"
								size="sm"
								aria-label="Close navigation menu"
								className="absolute top-2 right-2 h-8 w-8 p-0"
							>
								<X className="h-4 w-4" />
							</Button>
						</DialogPrimitive.Close>
					</DialogPrimitive.Content>
				</DialogPrimitive.Portal>
			</DialogPrimitive.Root>
		</div>
	);
}
