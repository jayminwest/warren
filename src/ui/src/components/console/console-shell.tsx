import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { ConsoleBottomNav } from "@/components/console/console-bottom-nav.tsx";
import { ConsoleSidebar, ConsoleSidebarBody } from "@/components/console/console-sidebar.tsx";
import { ConsoleMobileStatusStrip, ConsoleTopbar } from "@/components/console/console-topbar.tsx";
import { ShortcutHelp } from "@/components/console/shortcut-help.tsx";
import { useConsoleStats } from "@/components/console/use-console-stats.ts";
import { useGlobalKeys } from "@/components/console/use-global-keys.ts";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { WarrenLogo } from "@/components/warren-logo.tsx";

/**
 * The operator-console shell (warren-4ed7, polished in warren-a8c9): the
 * 224px sidebar and the status strip, with the routed page below. The
 * shell owns the ⌘K palette, the shortcut sheet, and the global keys.
 *
 * Below md the chrome splits into a brand bar, a status strip, and a
 * bottom tab bar whose "More" tab opens the sidebar as a drawer.
 */

// cmdk loads on first open, so it stays out of the first-load bundle.
const CommandPalette = lazy(() => import("@/components/console/command-palette.tsx"));

/** Page-level loading state while a lazy route chunk arrives. */
export function RouteFallback() {
	return (
		<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
			<div className="skeleton mb-6 h-7 w-48 rounded-sm" />
			<SkeletonRows rows={8} />
		</div>
	);
}

export function ConsoleShell() {
	const stats = useConsoleStats();
	const location = useLocation();
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const [paletteOpen, setPaletteOpen] = useState(false);
	// Mount the lazy palette only after its first open.
	const [paletteLoaded, setPaletteLoaded] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);

	const openPalette = useCallback(() => {
		setPaletteLoaded(true);
		setPaletteOpen(true);
		setMobileNavOpen(false);
	}, []);
	const openHelp = useCallback(() => setHelpOpen(true), []);
	useGlobalKeys({ onOpenPalette: openPalette, onOpenHelp: openHelp });

	// Close the drawer on route change so a mobile → desktop resize never
	// leaves a stale open flag.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not a read
	useEffect(() => {
		setMobileNavOpen(false);
	}, [location.pathname]);

	return (
		<div className="flex h-dvh flex-col md:flex-row">
			<ConsoleSidebar stats={stats} onOpenPalette={openPalette} />

			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{/* Phone chrome, below md: brand bar then status strip. */}
				<div className="flex h-12 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-sidebar) px-4 md:hidden">
					<Link
						to="/"
						aria-label="Warren home"
						className="flex min-w-0 items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
					>
						<WarrenLogo className="size-5 shrink-0" />
						<span className="text-sm font-semibold tracking-tight text-(--color-text)">warren</span>
						{stats.instanceName ? (
							<span className="truncate text-xs text-(--color-text-3)">{stats.instanceName}</span>
						) : null}
					</Link>
					<span className="flex-1" />
					<button
						type="button"
						onClick={openPalette}
						aria-label="Search"
						className="flex size-9 items-center justify-center rounded-sm text-(--color-text-2) hover:bg-(--color-surface-raised)"
					>
						<Search className="size-4.5" />
					</button>
				</div>
				<div className="md:hidden">
					<ConsoleMobileStatusStrip stats={stats} />
				</div>

				<div className="hidden md:block">
					<ConsoleTopbar stats={stats} onOpenHelp={openHelp} />
				</div>

				<main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
					{/* Boundary sits INSIDE the chrome so a page-level throw costs
					    the page, not the shell (warren-1f12). */}
					<ErrorBoundary resetKey={location.pathname}>
						<Suspense fallback={<RouteFallback />}>
							<Outlet />
						</Suspense>
					</ErrorBoundary>
				</main>

				<ConsoleBottomNav onOpenMore={() => setMobileNavOpen(true)} />
			</div>

			{/* Phone slide-over drawer: same sidebar body as the desktop rail. */}
			<DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
				<DialogPrimitive.Portal>
					<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm md:hidden" />
					<DialogPrimitive.Content
						aria-label="Navigation"
						className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-(--color-border) bg-(--color-sidebar) shadow-lg animate-fade-in md:hidden"
					>
						<DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
						<ConsoleSidebarBody
							stats={stats}
							onNavigate={() => setMobileNavOpen(false)}
							onOpenPalette={openPalette}
						/>
						<DialogPrimitive.Close asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label="Close navigation menu"
								className="absolute top-2.5 right-2"
							>
								<X className="size-4" />
							</Button>
						</DialogPrimitive.Close>
					</DialogPrimitive.Content>
				</DialogPrimitive.Portal>
			</DialogPrimitive.Root>

			{paletteLoaded ? (
				<Suspense fallback={null}>
					<CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onOpenHelp={openHelp} />
				</Suspense>
			) : null}
			<ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
		</div>
	);
}
