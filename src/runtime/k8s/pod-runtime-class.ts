/**
 * Per-project sandboxed RuntimeClass for RUN pods (warren-9bd3). Split out of
 * `pod-spec.ts` for the file-size ratchet, the same way `./pod-spot.ts` is.
 *
 * `.warren/config.yaml` `resources.runtimeClass` (for example `gvisor`) sets
 * `runtimeClassName` on the run pod. The RuntimeClass object's own
 * `scheduling` block carries the node selector and toleration for its sandbox
 * nodes, so the builder adds neither. GKE Autopilot provisions gVisor nodes on
 * demand.
 *
 * A sandboxed runtime changes the agent container's security posture, because
 * the default uid split (warren-cb93, `./agent-uid-drop.ts`) cannot run there:
 *
 *   - GKE Sandbox admission rejects `allowPrivilegeEscalation: true`, which the
 *     default split needs so the file-caps `setpriv` can gain SETUID/SETGID.
 *   - With no_new_privs on, file caps are inert, and gVisor does not carry
 *     ambient caps across a uid change (spike 2026-09-25). A uid-1000
 *     entrypoint therefore has no way to drop the agent to uid 1001.
 *
 * So under a sandboxed runtime the ENTRYPOINT runs as uid 0 inside the
 * sandbox, with only SETUID/SETGID/KILL and `allowPrivilegeEscalation: false`.
 * Root in a gVisor pod is root of the userspace kernel, not of the node. The
 * entrypoint still drops the AGENT to uid 1001 under no_new_privs. gVisor
 * ignores the bounding-set drop (CapBnd stays 0xe0), which grants nothing
 * because no exec can raise caps under no_new_privs. The split this module
 * exists to keep holds: the agent cannot read the
 * entrypoint's environ (the run token) or write its stdout. The init
 * container is untouched (uid 1000, no caps). Workspace writes by the root
 * entrypoint go through group 1000 (fsGroup plus the entrypoint's umask 002).
 */

import type { V1Pod, V1SecurityContext } from "@kubernetes/client-node";

/** The uid the entrypoint runs as under a sandboxed RuntimeClass. */
export const SANDBOXED_ENTRYPOINT_UID = 0;

/**
 * The agent container's securityContext under a sandboxed RuntimeClass. Pure.
 * `base` is the container's default context. `hasUidDrop` says whether the
 * entrypoint drops the agent to a separate uid. Without the split the
 * container keeps its non-root default; only `allowPrivilegeEscalation`
 * is pinned off.
 */
export function sandboxedAgentSecurityContext(
	base: V1SecurityContext,
	hasUidDrop: boolean,
): V1SecurityContext {
	if (!hasUidDrop) return { ...base, allowPrivilegeEscalation: false };
	return {
		...base,
		runAsUser: SANDBOXED_ENTRYPOINT_UID,
		runAsNonRoot: false,
		allowPrivilegeEscalation: false,
		capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID", "KILL"] },
	};
}

/**
 * Put `pod` on `runtimeClass` and switch its agent container to the
 * sandboxed posture. Mutates `pod`; call it last in the builder.
 */
export function applyRuntimeClass(pod: V1Pod, runtimeClass: string, hasUidDrop: boolean): void {
	if (pod.spec === undefined) return;
	pod.spec.runtimeClassName = runtimeClass;
	for (const container of pod.spec.containers) {
		container.securityContext = sandboxedAgentSecurityContext(
			container.securityContext ?? {},
			hasUidDrop,
		);
	}
}
