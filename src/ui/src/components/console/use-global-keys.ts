import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CHORD_NAV_ITEMS } from "@/components/console/console-nav.ts";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { isTypingTarget } from "@/hooks/use-list-keys.ts";
import { useTheme } from "@/hooks/use-theme.ts";

/**
 * Console-wide keys (warren-a8c9): ⌘K / Ctrl+K and `/` open the palette,
 * `G` then a letter jumps to a page, `C` starts a dispatch, `?` opens the
 * shortcut help, Shift+T flips the theme. Keys typed into a field are
 * left alone, except ⌘K.
 */

/** How long the `G` chord waits for its second key. */
const CHORD_WINDOW_MS = 1200;

export function useGlobalKeys({
	onOpenPalette,
	onOpenHelp,
}: {
	onOpenPalette: () => void;
	onOpenHelp: () => void;
}): void {
	const navigate = useNavigate();
	const caps = useCapabilities();
	const canDispatch = caps.can("dispatch");
	const { resolvedTheme, setTheme } = useTheme();

	useEffect(() => {
		const run: Record<Exclude<KeyAction, "chord" | null>, () => void> = {
			dispatch: () => {
				if (canDispatch) navigate("/dispatch");
			},
			palette: onOpenPalette,
			help: onOpenHelp,
			theme: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
		};
		let chordAt = 0;
		const onChordKey = (e: KeyboardEvent): void => {
			chordAt = 0;
			const hit = CHORD_NAV_ITEMS.find((item) => item.key === e.key.toLowerCase());
			if (!hit) return;
			// Capture phase + stop: a list page's J/K never sees the chord key.
			e.preventDefault();
			e.stopImmediatePropagation();
			navigate(hit.to);
		};
		const onKey = (e: KeyboardEvent): void => {
			const action = resolveKey(e, Date.now() - chordAt < CHORD_WINDOW_MS);
			if (action === "chord-key") onChordKey(e);
			else if (action === "chord") chordAt = Date.now();
			else if (action !== null) run[action]();
			if (action !== null && action !== "chord-key") e.preventDefault();
		};
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	}, [navigate, canDispatch, onOpenPalette, onOpenHelp, resolvedTheme, setTheme]);
}

/** A modified key, or one typed into a field, is not a page shortcut. */
function isIgnored(e: KeyboardEvent): boolean {
	return e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target);
}

/**
 * What a keystroke means. `chord-key` is the second key of a pending
 * `G` chord; ⌘K works even from inside a field.
 */
function resolveKey(e: KeyboardEvent, chordPending: boolean): KeyAction | "chord-key" {
	if (isPaletteCombo(e)) return "palette";
	if (isIgnored(e)) return null;
	if (chordPending) return "chord-key";
	return actionFor(e);
}

function isPaletteCombo(e: KeyboardEvent): boolean {
	return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}

type KeyAction = "chord" | "dispatch" | "palette" | "help" | "theme" | null;

function actionFor(e: KeyboardEvent): KeyAction {
	if (e.key === "T" && e.shiftKey) return "theme";
	if (e.key === "?") return "help";
	if (e.shiftKey) return null;
	if (e.key === "g") return "chord";
	if (e.key === "c") return "dispatch";
	if (e.key === "/") return "palette";
	return null;
}
