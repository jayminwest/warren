import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "warren.theme";

function isTheme(value: unknown): value is Theme {
	return value === "light" || value === "dark" || value === "system";
}

function readStoredTheme(): Theme {
	if (typeof window === "undefined") return "system";
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw === null) return "system";
		if (isTheme(raw)) return raw;
		// Invalid value: clear and fall back to system.
		window.localStorage.removeItem(STORAGE_KEY);
		return "system";
	} catch {
		return "system";
	}
}

function getSystemTheme(): ResolvedTheme {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return "light";
	}
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme, system: ResolvedTheme): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	// Always set a concrete data-theme=light|dark on <html> (warren-23fe):
	// the index.css token sheet and the @custom-variant dark rule both key
	// off this attribute as the single source of truth. "system" is
	// resolved to the current OS preference here at runtime.
	root.dataset.theme = theme === "system" ? system : theme;
}

function persistTheme(theme: Theme): void {
	if (typeof window === "undefined") return;
	try {
		if (theme === "system") {
			window.localStorage.removeItem(STORAGE_KEY);
		} else {
			window.localStorage.setItem(STORAGE_KEY, theme);
		}
	} catch {
		// Ignore storage failures (private mode, quota, etc.).
	}
}

export function useTheme(): {
	theme: Theme;
	setTheme: (theme: Theme) => void;
	resolvedTheme: ResolvedTheme;
} {
	const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
	const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());

	// Apply on mount and whenever theme or the resolved system preference
	// changes. The FOUC-prevention script in index.html sets data-theme
	// synchronously before React paints; this keeps the attribute in sync
	// afterwards (including when the OS preference flips while theme ===
	// "system").
	useEffect(() => {
		applyTheme(theme, systemTheme);
	}, [theme, systemTheme]);

	// Track OS preference whenever a media query is available. We keep the
	// listener attached even when theme !== "system" so that switching back
	// to "system" picks up the current OS value without a remount.
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (e: MediaQueryListEvent): void => {
			setSystemTheme(e.matches ? "dark" : "light");
		};
		// Sync once in case it changed before we attached.
		setSystemTheme(mq.matches ? "dark" : "light");
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	const setTheme = useCallback((next: Theme): void => {
		persistTheme(next);
		setThemeState(next);
	}, []);

	const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

	return { theme, setTheme, resolvedTheme };
}
