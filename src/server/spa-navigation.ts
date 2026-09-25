/**
 * SPA deep links that share a path with an API route (warren-0a17).
 *
 * The React router mounts pages at `/runs/:id`, `/projects`, and so on,
 * and the JSON API claims the same paths (`API_PREFIXES`). Client-side
 * navigation never asks the server for them, but a browser refresh or a
 * pasted link does. Without this check that request hit the auth gate
 * and the operator saw a 401 JSON envelope instead of the app.
 *
 * A browser document navigation to one of these exact shapes gets the SPA
 * shell. The shell is public already (it is what `/` serves), so this
 * exposes nothing. API clients never send a document navigation: the UI
 * client, the SDK, and the CLI send `accept: application/json` or no
 * fetch metadata. `/setup` is left out on purpose because its API route
 * serves its own HTML page.
 */

/** UI route shapes that collide with an API path. Mirrors `src/ui/src/app.tsx`. */
const SPA_ROUTES: readonly RegExp[] = [
	/^\/runs\/?$/,
	/^\/runs\/[^/]+\/?$/,
	/^\/plan-runs\/?$/,
	/^\/plan-runs\/[^/]+\/?$/,
	/^\/projects\/?$/,
	/^\/projects\/[^/]+\/?$/,
	/^\/agents\/?$/,
	/^\/events\/?$/,
	/^\/instance\/?$/,
];

/** True when the browser is loading `request` as a top-level page. */
function isDocumentNavigation(request: Request): boolean {
	const mode = request.headers.get("sec-fetch-mode");
	if (mode !== null) return mode === "navigate";
	// Older browsers omit fetch metadata; fall back to the Accept header.
	return (request.headers.get("accept") ?? "").includes("text/html");
}

/** True when a GET for `pathname` should get the SPA shell, not the API. */
export function isSpaDeepLink(request: Request, pathname: string): boolean {
	if (request.method.toUpperCase() !== "GET") return false;
	if (!SPA_ROUTES.some((re) => re.test(pathname))) return false;
	return isDocumentNavigation(request);
}
