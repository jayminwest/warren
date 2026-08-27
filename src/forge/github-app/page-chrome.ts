/**
 * Shared chrome for the server-rendered GitHub App registration pages
 * (warren-4f1e). Every page in the flow — register, credentials, installed,
 * error — renders through {@link renderRegistrationChrome} so they cannot
 * drift from each other in styling or structure.
 *
 * Hard constraints (unchanged by this styling pass):
 *
 * - The pages are anonymous and served under `Content-Security-Policy:
 *   default-src 'none'` — no external assets, fonts, or scripts, and no
 *   inline `<script>`. A single inline `<style>` block is all the styling
 *   surface available, so the token values below are literal.
 * - They must render with zero SPA assets built: the flow exists for
 *   first-boot setup, exactly when `src/ui/dist/` may not exist.
 *
 * The token VALUES mirror the Direction C dark palette
 * (`src/ui/src/tokens.css`, the `:root` base block) — same neutral hue
 * family, same brand green, same flattened radius scale, and the same
 * font stacks (the self-hosted variable fonts named first can never load
 * under this CSP, so the system fallbacks render). The pages stay
 * dark-only on purpose: the SPA's theme switch needs the FOUC script,
 * and CSP forbids inline scripts here. When the SPA tokens move, move
 * these too.
 */

/**
 * The inline stylesheet, derived from the Direction C dark tokens.
 * Selector style stays element-level on purpose: these pages are
 * hand-authored HTML strings, and class plumbing through every call site
 * is the drift surface this helper exists to remove.
 */
export const REGISTRATION_CHROME_STYLE = `
	:root {
		--bg: oklch(14% 0.008 264);
		--surface: oklch(16.5% 0.01 264);
		--text: oklch(96% 0.005 264);
		--text-2: oklch(72% 0.012 264);
		--border: oklch(24% 0.012 264);
		--primary: oklch(72% 0.11 152);
		--primary-ink: oklch(15% 0.01 152);
		--radius-sm: 3px;
		--radius-md: 4px;
	}
	body {
		margin: 0;
		padding: 0 1rem;
		background: var(--bg);
		color: var(--text);
		font-family: "Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
		line-height: 1.5;
	}
	header {
		border-bottom: 1px solid var(--border);
		margin-bottom: 2rem;
	}
	header .brand {
		max-width: 52rem;
		margin: 0 auto;
		padding: 1rem 0;
		font-weight: 600;
		letter-spacing: -0.025em;
	}
	header .brand span { color: var(--primary); }
	main { max-width: 52rem; margin: 0 auto 3rem; }
	h1 { font-size: 1.25rem; font-weight: 600; margin: 1.75rem 0 0.5rem; }
	h2 { font-size: 1rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }
	p { margin: 0.5rem 0; }
	a { color: var(--primary); }
	code, pre {
		font-family: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}
	pre {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 0.75rem;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-all;
	}
	button {
		font: inherit;
		font-weight: 500;
		padding: 0.5rem 1rem;
		border-radius: var(--radius-sm);
		border: none;
		background: var(--primary);
		color: var(--primary-ink);
		cursor: pointer;
	}
	dt { font-weight: 600; margin-top: 0.5rem; }
	dd { margin-left: 0; }
	.note { color: var(--text-2); font-size: 0.875rem; }
`;

/**
 * The shared page skeleton: doctype, head, the inline stylesheet, the
 * warren brand header, and the body content inside `<main>`. `title` and
 * `body` must already be HTML-escaped by the caller — `body` is trusted
 * markup, matching the prior per-page renderers.
 */
export function renderRegistrationChrome(title: string, body: string): string {
	return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>warren — ${title}</title>
<style>${REGISTRATION_CHROME_STYLE}</style>
</head>
<body>
<header><div class="brand">warren<span>.</span></div></header>
<main>
${body}
</main>
</body>
</html>
`;
}
