import { describe, expect, test } from "bun:test";
import { UnauthorizedError } from "../api/client.ts";
import type { WhoamiResponse } from "../api/types.ts";
import { resolveCapabilities, retryWhoami } from "./use-capabilities.helpers.ts";

/**
 * The UI capability layer's whole decision (warren-f53e / pl-b82d step 19).
 * The headline guarantee is that the three "not yet / not you / broken"
 * outcomes are all FAIL-CLOSED and all DISTINGUISHABLE:
 *
 *   - a 401 means "go to /login", NOT "you are an anonymous spectator" —
 *     under the default `WARREN_AUTH=token` a tokenless browser gets 401
 *     from `/whoami` too (warren-e195), and reading that as anonymous would
 *     strand the operator on a read-only UI with no way to log in;
 *   - a transient failure is neither, so it must not silently demote an
 *     operator;
 *   - none of the three may report a capability.
 */

const ANONYMOUS: WhoamiResponse = { identity: "anonymous", capabilities: ["readPublic"] };
const OPERATOR: WhoamiResponse = {
	identity: "operator",
	capabilities: ["readPublic", "readOperator", "dispatch", "admin"],
};

describe("resolveCapabilities", () => {
	test("no data and no error is loading, and grants nothing", () => {
		const caps = resolveCapabilities({ data: undefined, error: null });
		expect(caps.status).toBe("loading");
		expect(caps.identity).toBeNull();
		expect(caps.granted).toEqual([]);
		expect(caps.can("readPublic")).toBe(false);
		expect(caps.can("dispatch")).toBe(false);
	});

	test("an operator body grants every capability it lists", () => {
		const caps = resolveCapabilities({ data: OPERATOR, error: null });
		expect(caps.status).toBe("ready");
		expect(caps.identity).toBe("operator");
		expect(caps.can("readPublic")).toBe(true);
		expect(caps.can("readOperator")).toBe(true);
		expect(caps.can("dispatch")).toBe(true);
		expect(caps.can("admin")).toBe(true);
		expect(caps.error).toBeNull();
	});

	test("an anonymous body grants readPublic and nothing else", () => {
		const caps = resolveCapabilities({ data: ANONYMOUS, error: null });
		expect(caps.status).toBe("ready");
		expect(caps.identity).toBe("anonymous");
		expect(caps.granted).toEqual(["readPublic"]);
		expect(caps.can("readPublic")).toBe(true);
		expect(caps.can("readOperator")).toBe(false);
		expect(caps.can("dispatch")).toBe(false);
		expect(caps.can("admin")).toBe(false);
	});

	test("a 401 is 'unauthenticated', not 'anonymous'", () => {
		const caps = resolveCapabilities({
			data: undefined,
			error: new UnauthorizedError("API token rejected; please re-authenticate"),
		});
		expect(caps.status).toBe("unauthenticated");
		expect(caps.identity).toBeNull();
		expect(caps.can("readPublic")).toBe(false);
		// A 401 is a permission answer, so there is nothing to surface.
		expect(caps.error).toBeNull();
	});

	test("any other failure is 'error' and keeps the cause for display", () => {
		const boom = new Error("network down");
		const caps = resolveCapabilities({ data: undefined, error: boom });
		expect(caps.status).toBe("error");
		expect(caps.error).toBe(boom);
		expect(caps.can("readPublic")).toBe(false);
	});

	test("data wins over a stale error from an earlier failed fetch", () => {
		const caps = resolveCapabilities({ data: OPERATOR, error: new Error("earlier blip") });
		expect(caps.status).toBe("ready");
		expect(caps.can("dispatch")).toBe(true);
	});
});

describe("retryWhoami", () => {
	test("never retries a 401 — the answer is final", () => {
		expect(retryWhoami(0, new UnauthorizedError("nope"))).toBe(false);
	});

	test("retries other failures twice so a blip can't demote an operator", () => {
		const boom = new Error("ECONNRESET");
		expect(retryWhoami(0, boom)).toBe(true);
		expect(retryWhoami(1, boom)).toBe(true);
		expect(retryWhoami(2, boom)).toBe(false);
	});
});
