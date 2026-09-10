import { type Issue, isIssueStatus, TrackerError } from "../../core/wire.ts";

export function parseRemoteIssue(raw: unknown): Issue {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new TrackerError("remote tracker returned a malformed issue payload");
	const value = raw as Record<string, unknown>;
	if (typeof value.id !== "string")
		throw new TrackerError("remote tracker returned an invalid issue id");
	if (!isIssueStatus(value.status))
		throw new TrackerError(
			`remote tracker returned unknown issue status "${String(value.status)}" for issue ${value.id}`,
		);
	for (const name of ["title", "description", "url", "repositoryUrl"]) {
		if (value[name] !== undefined && typeof value[name] !== "string")
			throw new TrackerError(`remote tracker returned an invalid issue ${name}`);
	}
	if (value.ready !== undefined && typeof value.ready !== "boolean")
		throw new TrackerError("remote tracker returned an invalid issue readiness");
	validateIssueCollections(value);
	return value as unknown as Issue;
}

function validateIssueCollections(value: Record<string, unknown>): void {
	if (
		value.blockedBy !== undefined &&
		(!Array.isArray(value.blockedBy) ||
			value.blockedBy.some((id: unknown) => typeof id !== "string"))
	)
		throw new TrackerError("remote tracker returned invalid issue blockers");
	if (
		value.metadata !== undefined &&
		(!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata))
	)
		throw new TrackerError("remote tracker returned invalid issue metadata");
}
