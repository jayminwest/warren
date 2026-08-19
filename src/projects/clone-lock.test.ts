import { describe, expect, test } from "bun:test";
import { withProjectCloneLock } from "./clone-lock.ts";

/**
 * warren-232d: the per-project keyed mutex. Same-project critical sections run
 * strictly one at a time (in acquisition order); different projects run in
 * parallel; a failed section never wedges the queue.
 */
describe("withProjectCloneLock", () => {
	test("serializes concurrent sections on the same project id", async () => {
		let active = 0;
		let maxActive = 0;
		const order: string[] = [];
		const section = (name: string) =>
			withProjectCloneLock("prj_a", async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				order.push(`start:${name}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
				order.push(`end:${name}`);
				active -= 1;
				return name;
			});

		const results = await Promise.all([section("one"), section("two"), section("three")]);
		expect(results).toEqual(["one", "two", "three"]);
		// No interleaving: each section fully completes before the next starts.
		expect(maxActive).toBe(1);
		expect(order).toEqual([
			"start:one",
			"end:one",
			"start:two",
			"end:two",
			"start:three",
			"end:three",
		]);
	});

	test("different project ids run in parallel", async () => {
		let active = 0;
		let maxActive = 0;
		const section = (id: string) =>
			withProjectCloneLock(id, async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active -= 1;
				return id;
			});

		await Promise.all([section("prj_a"), section("prj_b")]);
		expect(maxActive).toBe(2);
	});

	test("a failed section propagates its error without wedging the next waiter", async () => {
		const boom = withProjectCloneLock("prj_c", async () => {
			throw new Error("checkout failed");
		});
		await expect(boom).rejects.toThrow("checkout failed");
		// The queue must still drain: the next dispatch on the same project runs.
		await expect(withProjectCloneLock("prj_c", async () => "recovered")).resolves.toBe("recovered");
	});
});
