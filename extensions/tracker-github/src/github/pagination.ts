import { malformed, object, TrackerFailure } from "../errors.ts";

export function nextCursor(raw: unknown, seen: Set<string>): string | null {
	const page = object(raw);
	if (page.hasNextPage === false) return null;
	if (
		page.hasNextPage !== true ||
		typeof page.endCursor !== "string" ||
		!page.endCursor ||
		seen.has(page.endCursor)
	)
		return malformed();
	seen.add(page.endCursor);
	return page.endCursor;
}

export function pageLimit(): never {
	throw new TrackerFailure(
		"pagination_limit",
		"GitHub pagination limit exceeded; narrow the scope or raise GITHUB_MAX_PAGES",
		422,
	);
}
