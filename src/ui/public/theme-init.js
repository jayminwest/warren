// FOUC guard (warren-40f1): resolve the persisted theme (or the OS
// preference for "system") to a concrete data-theme=light|dark on <html>
// before React paints. It ships as an external classic script, not inline,
// because the server CSP is `script-src 'self'`. Keep in sync with
// src/hooks/use-theme.ts (key: warren.theme). Dark is the fallback.
(() => {
	try {
		const stored = localStorage.getItem("warren.theme");
		const choice = stored === "light" || stored === "dark" ? stored : "system";
		const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
		document.documentElement.dataset.theme =
			choice === "system" ? (prefersLight ? "light" : "dark") : choice;
	} catch (_) {
		document.documentElement.dataset.theme = "dark";
	}
})();
