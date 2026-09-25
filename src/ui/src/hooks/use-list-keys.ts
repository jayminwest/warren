import { useCallback, useEffect, useRef, useState } from "react";

/** True when a keystroke belongs to a text field, not to page shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	return (
		el.tagName === "INPUT" ||
		el.tagName === "TEXTAREA" ||
		el.tagName === "SELECT" ||
		el.isContentEditable
	);
}

const STEP_KEYS: Readonly<Record<string, number>> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };

/**
 * Keyboard selection for a list page (warren-a8c9): J/K or the arrow keys
 * move a highlight through `count` rows, Enter opens the highlighted row,
 * Escape clears it. The selected row scrolls into view. Give each row
 * `ref={setRef(i)}` and `data-selected={selected === i}`.
 */
export function useListKeys(count: number, onOpen: (index: number) => void) {
	const [selected, setSelected] = useState<number | null>(null);
	const refs = useRef<(HTMLElement | null)[]>([]);
	const openRef = useRef(onOpen);
	openRef.current = onOpen;

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || count === 0) return;
			const step = STEP_KEYS[e.key];
			if (step !== undefined) {
				e.preventDefault();
				setSelected((s) => (s === null ? 0 : Math.min(count - 1, Math.max(0, s + step))));
			} else if (e.key === "Enter" && selected !== null) {
				e.preventDefault();
				openRef.current(selected);
			} else if (e.key === "Escape") {
				setSelected(null);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [count, selected]);

	useEffect(() => {
		if (selected === null) return;
		refs.current[selected]?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	// A shrinking list must not leave the highlight past its end.
	useEffect(() => {
		setSelected((s) => (s !== null && s >= count ? (count > 0 ? count - 1 : null) : s));
	}, [count]);

	const setRef = useCallback(
		(i: number) => (el: HTMLElement | null) => {
			refs.current[i] = el;
		},
		[],
	);
	return { selected, setRef };
}
