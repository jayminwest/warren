/**
 * The slice of the Azure DevOps Boards REST 7.1 response shapes this
 * tracker reads.
 *
 * The client checks a payload against these before handing it on, so
 * the id and state every operation needs are present. Everything else
 * is optional on purpose: a work item carries only the fields its
 * process template defines, a relation can arrive without attributes,
 * and a proxy can strip things, so the mapping narrows rather than
 * trusts. Nothing here is an SDK type import: the payloads cross an HTTP
 * boundary, so they are parsed, not asserted.
 */

export const ADO_API_VERSION = "7.1";

/** The fields this tracker reads, by their reference names. */
export interface AdoWorkItemFields {
	readonly "System.State": string;
	readonly "System.Title"?: string | null;
	/** HTML on every process template. */
	readonly "System.Description"?: string | null;
	readonly "System.WorkItemType"?: string | null;
	/** HTML; present on stories and bugs in Agile and Scrum. */
	readonly "Microsoft.VSTS.Common.AcceptanceCriteria"?: string | null;
	/** HTML; a bug in Agile carries its narrative here instead of the description. */
	readonly "Microsoft.VSTS.TCM.ReproSteps"?: string | null;
}

export interface AdoRelation {
	/** The link type reference name, such as `System.LinkTypes.Dependency-Reverse`. */
	readonly rel?: string;
	/** The linked work item's REST url; the id is its last path segment. */
	readonly url?: string;
}

export interface AdoWorkItem {
	readonly id: number;
	/** The revision number; a state change names it so a concurrent edit is refused. */
	readonly rev: number;
	readonly fields: AdoWorkItemFields;
	readonly relations?: readonly AdoRelation[];
}

export interface AdoWorkItemTypeState {
	readonly name?: string;
	/** One of `Proposed`, `InProgress`, `Resolved`, `Completed`, `Removed`. */
	readonly category?: string;
}

/** The state category a work item starts in, before anyone picks it up. */
export const ADO_PROPOSED_CATEGORY = "Proposed";

/** The state category every finished work item lands in. */
export const ADO_COMPLETED_CATEGORY = "Completed";

/** The state category of a work item taken off the backlog without finishing. */
export const ADO_REMOVED_CATEGORY = "Removed";
