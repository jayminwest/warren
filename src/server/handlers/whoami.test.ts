/**
 * Wire-level tests for `GET /whoami` (warren-e195).
 *
 * The route exists so the UI can render from a capability set instead of
 * guessing from "is there a token in localStorage", so what matters is that
 * each auth mode answers with the identity that mode actually admitted —
 * and that the default token mode still refuses a credential-less caller
 * rather than telling it that it is anonymous.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import {
	ANONYMOUS_ACTOR,
	bearerAuth,
	grantedCapabilities,
	NO_AUTH,
	OPERATOR_ACTOR,
	publicReadAuth,
} from "../auth.ts";
import { startServer } from "../server.ts";
import type { AuthProvider, ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

const TOKEN = "s3cret";

interface WhoamiBody {
	identity: string;
	capabilities: string[];
}

/** A burrow client that 404s everything — `/whoami` never reaches it. */
function inertSandboxClient(): FakeProvider {
	return new FakeProvider();
}

describe("GET /whoami", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function serve(auth: AuthProvider): Promise<string> {
		handle = startServer(await depsFor(repos, inertSandboxClient()), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	test("an anonymous caller under WARREN_AUTH=public learns it is anonymous", async () => {
		const base = await serve(publicReadAuth(bearerAuth(TOKEN)));
		const res = await fetch(`${base}/whoami`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ identity: "anonymous", capabilities: ["readPublic"] });
	});

	test("the operator's token yields the full capability set", async () => {
		const base = await serve(publicReadAuth(bearerAuth(TOKEN)));
		const res = await fetch(`${base}/whoami`, { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			identity: "operator",
			capabilities: ["readPublic", "readOperator", "dispatch", "admin"],
		});
	});

	test("the default token mode still 401s a credential-less caller", async () => {
		const base = await serve(bearerAuth(TOKEN));
		const res = await fetch(`${base}/whoami`);
		// Never a degraded "you are anonymous" — under `token` there is no
		// anonymous identity to report, and the SPA routes the 401 to login.
		expect(res.status).toBe(401);
	});

	test("--no-auth reports the operator (loopback dev loop)", async () => {
		const base = await serve(NO_AUTH);
		const res = await fetch(`${base}/whoami`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as WhoamiBody).identity).toBe("operator");
	});

	test("the body is marked as varying by Authorization so no proxy shares it", async () => {
		const base = await serve(publicReadAuth(bearerAuth(TOKEN)));
		const res = await fetch(`${base}/whoami`);
		expect(res.headers.get("vary")).toBe("Authorization");
		await res.body?.cancel();
	});
});

describe("grantedCapabilities", () => {
	test("emits every capability the operator holds, so none can drop off the wire", () => {
		const held: readonly string[] = grantedCapabilities(OPERATOR_ACTOR);
		expect([...held].sort()).toEqual(Object.keys(OPERATOR_ACTOR.capabilities).sort());
	});

	test("omits the capabilities an actor lacks", () => {
		expect(grantedCapabilities(ANONYMOUS_ACTOR)).toEqual(["readPublic"]);
	});
});
