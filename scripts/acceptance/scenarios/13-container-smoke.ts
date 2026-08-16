/**
 * Scenario 13 — container-mode boot smoke.
 *
 * Acceptance criterion #13 (the "deploy shape" check):
 *   "docker compose up on a fresh host boots warren; UI reachable on
 *   localhost:<port>; healthz returns 200; readyz returns a structured
 *   body; built-in agents are seeded so a no-canopy install can list
 *   agents."
 *
 * In-proc mode already covers the application contract end-to-end
 * (scenarios 01–12). Container mode is the only path that exercises
 * the supervisor + Dockerfile + docker-compose.yml as a unit:
 *   - the image builds (ui-builder + runtime stages),
 *   - the supervisor (`bun run src/supervisor/main.ts`) boots burrow
 *     under the four bwrap-friendly security flags (apparmor=unconfined,
 *     seccomp=unconfined, systempaths=unconfined, cap_add=SYS_ADMIN),
 *   - warren and burrow start as siblings on the in-container socket,
 *   - /healthz responds 200 (auth-exempt),
 *   - GET /agents (with auth) returns the three built-in agents,
 *     `claude-code` and `pi`, all with `source: "builtin"`,
 *   - /readyz returns a structured `{ ok, checks: [...] }` body
 *     (we don't assert ok=true; bwrap probe behaviour on macOS Docker
 *     Desktop is host-dependent — see body comment below).
 *
 * Scenarios that depend on host-side fixtures (canopy library, sample
 * project) or on driving the warren CLI as a host child process declare
 * `modes: ["in-proc"]` and skip in container mode (per warren-fab1 and
 * the compose harness's no-bind-mount design).
 *
 * Container mode requires `docker` on PATH and a running Docker daemon.
 * On macOS Docker Desktop the four security flags are honored, but
 * `cap_add: SYS_ADMIN` may be partial — boot still succeeds, but
 * dispatching a real run with bwrap nesting is Linux-only territory and
 * is not asserted here.
 */

import { assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface AgentRow {
	readonly name: string;
	readonly source?: string;
}

interface AgentsResponse {
	readonly agents: readonly AgentRow[];
}

interface ReadyzResponse {
	readonly ok: boolean;
	readonly checks?: readonly { readonly name: string; readonly ok: boolean }[];
}

export const scenario: Scenario = {
	id: "13",
	title:
		"container boot — image builds, supervisor + bwrap flags hold, healthz/readyz/agents respond",
	modes: ["container"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// /healthz is auth-exempt and is the harness's "container is up"
		// signal; bootCompose already polled it, but we re-assert here so
		// scenario 13 owns its own contract.
		const healthzRes = await fetch(http.url("/healthz"));
		assertEqual(healthzRes.status, 200, "/healthz returns 200 in container");

		// 401 without auth on a protected route — proves the auth middleware
		// is active inside the container (WARREN_API_TOKEN was set via the
		// compose override env block).
		const unauth = await fetch(http.url("/agents"));
		assertEqual(unauth.status, 401, "GET /agents returns 401 without bearer token");

		// GET /agents (authenticated) returns the built-in agents the boot
		// path seeds before exposing /healthz. The container has no canopy
		// library configured (CANOPY_REPO_URL is blanked by the override),
		// so every row should carry `source: "builtin"`.
		const agentsBody = await http.expectJson<AgentsResponse>("GET", "/agents", 200);
		assertTrue(
			Array.isArray(agentsBody.agents),
			`GET /agents body shape unexpected: ${JSON.stringify(agentsBody).slice(0, 200)}`,
		);
		const names = new Set(agentsBody.agents.map((a) => a.name));
		for (const expected of ["claude-code", "pi"]) {
			assertTrue(
				names.has(expected),
				`GET /agents missing builtin ${expected}; got [${[...names].join(", ")}]`,
			);
		}
		const nonBuiltin = agentsBody.agents.filter((a) => a.source !== "builtin");
		assertEqual(
			nonBuiltin.length,
			0,
			`expected only builtin agents in container with no CANOPY_REPO_URL; got non-builtin: ${nonBuiltin
				.map((a) => `${a.name}=${a.source}`)
				.join(", ")}`,
		);

		// /readyz returns a structured body. We don't assert ok=true: the
		// canopy_clone probe reports "no library configured" (not failure)
		// when CANOPY_REPO_URL is unset (warren-d3e9), and bwrap probe
		// behaviour on macOS Docker Desktop is host-dependent. The contract
		// is "warren reports its own readiness honestly", which means the
		// shape is well-formed and `checks` is a populated array.
		const readyzRes = await http.request("GET", "/readyz");
		assertTrue(
			readyzRes.status === 200 || readyzRes.status === 503,
			`/readyz returned unexpected status ${readyzRes.status}`,
		);
		const readyzBody = (await readyzRes.json()) as ReadyzResponse;
		assertTrue(
			typeof readyzBody.ok === "boolean",
			`/readyz body missing 'ok' boolean: ${JSON.stringify(readyzBody).slice(0, 200)}`,
		);
		assertTrue(
			Array.isArray(readyzBody.checks) && readyzBody.checks.length > 0,
			`/readyz body should carry a populated 'checks' array; got ${JSON.stringify(readyzBody).slice(0, 200)}`,
		);
		ctx.logger.debug(
			`scenario-13: readyz status=${readyzRes.status} ok=${readyzBody.ok} checks=${(readyzBody.checks ?? []).length}`,
		);
	},
};
