// FOUC guard (warren-40f1): resolve the persisted theme (or the OS
// preference for "system") to a concrete data-theme=light|dark on <html>
// before React paints. It ships as an external classic script, not
// inline, because the server CSP is `script-src 'self'`, which blocks
// inline scripts. Keep in sync with src/hooks/use-theme.ts (key:
// warren.theme). Resolving "system" here, rather than leaving the
// attribute unset, is what lets the single `:root[data-theme="dark"]`
// block in index.css (warren-23fe) and the `dark:` Tailwind variant
// (@custom-variant dark) track the toggle from first paint.
(() => {
	try {
		const stored = localStorage.getItem("warren.theme");
		const choice =
			stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
		const resolved =
			choice === "system"
				? window.matchMedia?.("(prefers-color-scheme: dark)").matches
					? "dark"
					: "light"
				: choice;
		document.documentElement.dataset.theme = resolved;
	} catch (_) {
		document.documentElement.dataset.theme = "light";
	}
})();
