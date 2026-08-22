/**
 * `POST /runs/:id/git-credential` — the control-plane mint endpoint the in-pod
 * finalize harness calls when it needs a push credential and no reap intent
 * parked one (forge-contract.md §4.1 window 3, warren-c9ac).
 *
 * The pod CANNOT hold an App private key, so the old fallback — reading the
 * long-lived `warren-git-token` Secret mounted into the pod env — breaks under
 * App mode (an installation token expires after one hour; a run can outlive
 * it). The resolved design routes this window through the same authenticated
 * callback channel the intent poll already uses: the pod asks warren, warren
 * mints a FRESH credential off the boot-resolved forge
 * (`mintGitCredential`, §4: minted, never held), and returns it in the
 * response body. Under App mode this is the ONLY credential path the salvage
 * window can rely on; the pod-side static env is a last resort for PAT mode.
 *
 * Returns `{ gitToken: string | null }` — `null` when the forge mints
 * anonymously (foreign host / no credential configured), matching the
 * optional-token posture of the rest of the pipeline; the pod then pushes
 * anonymously (public repos) or records the failure. A genuine mint failure
 * throws `GitCredentialMintError` → 500, and the pod falls back to its
 * env-carried token rather than losing the salvage bundle (the bundle POST
 * never needs git).
 *
 * Bearer-gated like every other `/runs` route (policy `dispatch`, mirroring
 * the finalize-result + salvage intakes): the pod carries its per-run SCOPED
 * callback token (warren-57fd), which authorizes exactly this run's surface.
 */

import { NotFoundError } from "../../../core/errors.ts";
import { mintGitCredential } from "../../../forge/credentials.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { requireParam } from "../index.ts";

export function postRunGitCredentialHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const run = await deps.repos.runs.get(id);
		if (run === null || run.projectId === null) throw new NotFoundError(`run ${id}`);
		const project = await deps.repos.projects.get(run.projectId);
		if (project === null) {
			throw new NotFoundError(`project ${run.projectId} for run ${id}`);
		}
		const gitCredential = await mintGitCredential(deps.forge, project.gitUrl);
		// The in-pod wire carries the bare secret (the pod injects it into the
		// origin URL rather than rendering an insteadOf rule), so the credential
		// flattens here. warren-1b6f left that half of the wire alone.
		return jsonResponse(200, { gitToken: gitCredential?.secret ?? null });
	};
}
