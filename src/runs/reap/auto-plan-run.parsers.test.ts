import { describe, expect, test } from "bun:test";
import { parsePlanChildren, parsePlanIds } from "./auto-plan-run.ts";

/* Direct unit tests for parsePlanIds / parsePlanChildren (warren-3add).   */
/* The integration path through reapRun is covered in auto-plan-run.test.ts. */
/* ----------------------------------------------------------------------- */

describe("parsePlanIds", () => {
	test("collects string ids from every well-formed object line", () => {
		const body = '{"id":"pl-1","status":"approved"}\n{"id":"pl-2","status":"approved"}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-1", "pl-2"]));
	});

	test("deduplicates repeated ids into a single set entry", () => {
		expect(parsePlanIds('{"id":"pl-1"}\n{"id":"pl-1"}\n')).toEqual(new Set(["pl-1"]));
	});

	test("skips lines that are not valid JSON (malformed)", () => {
		expect(parsePlanIds('not json\n{"id":"pl-1"}\n{broken\n')).toEqual(new Set(["pl-1"]));
	});

	test("skips null / array / primitive lines (non-object)", () => {
		const body = 'null\n[1,2,3]\n"hello"\n42\ntrue\n{"id":"pl-1"}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-1"]));
	});

	test("skips objects with a missing id field", () => {
		expect(parsePlanIds('{"status":"approved"}\n{"id":"pl-1"}\n')).toEqual(new Set(["pl-1"]));
	});

	test("skips objects whose id is the wrong type", () => {
		const body =
			'{"id":123}\n' +
			'{"id":null}\n' +
			'{"id":true}\n' +
			'{"id":["pl-x"]}\n' +
			'{"id":{"nested":true}}\n' +
			'{"id":"pl-1"}\n';
		expect(parsePlanIds(body)).toEqual(new Set(["pl-1"]));
	});

	test("skips objects whose id is an empty string", () => {
		expect(parsePlanIds('{"id":""}\n{"id":"pl-1"}\n')).toEqual(new Set(["pl-1"]));
	});

	test("returns an empty set for an empty or whitespace-only body", () => {
		expect(parsePlanIds("")).toEqual(new Set());
		expect(parsePlanIds("  \n  \n\t")).toEqual(new Set());
	});
});

describe("parsePlanChildren", () => {
	test("returns the children array of the first line matching planId", () => {
		const body = '{"id":"pl-1","children":["warren-a","warren-b"]}\n';
		expect(parsePlanChildren(body, "pl-1")).toEqual(["warren-a", "warren-b"]);
	});

	test("scans past malformed lines to find the matching plan", () => {
		expect(parsePlanChildren('not json\n{"id":"pl-1","children":["warren-a"]}\n', "pl-1")).toEqual([
			"warren-a",
		]);
	});

	test("scans past non-object lines (null / array / primitive)", () => {
		const body = 'null\n[1,2]\n"hello"\n{"id":"pl-1","children":["warren-a"]}\n';
		expect(parsePlanChildren(body, "pl-1")).toEqual(["warren-a"]);
	});

	test("scans past lines whose id does not match planId", () => {
		const body =
			'{"id":"pl-other","children":["warren-x"]}\n' + '{"id":"pl-1","children":["warren-a"]}\n';
		expect(parsePlanChildren(body, "pl-1")).toEqual(["warren-a"]);
	});

	test("returns the first matching line's children when several match", () => {
		const body =
			'{"id":"pl-1","children":["warren-first"]}\n' +
			'{"id":"pl-1","children":["warren-second"]}\n';
		expect(parsePlanChildren(body, "pl-1")).toEqual(["warren-first"]);
	});

	test("returns an empty array when no line matches planId", () => {
		expect(parsePlanChildren('{"id":"pl-other","children":["warren-x"]}\n', "pl-1")).toEqual([]);
	});

	test("returns an empty array when the body is empty or whitespace-only", () => {
		expect(parsePlanChildren("", "pl-1")).toEqual([]);
		expect(parsePlanChildren("  \n\t\n", "pl-1")).toEqual([]);
	});

	test("returns an empty array when the matching plan has no children field", () => {
		expect(parsePlanChildren('{"id":"pl-1","status":"approved"}\n', "pl-1")).toEqual([]);
	});

	test("returns an empty array when children is the wrong type", () => {
		expect(parsePlanChildren('{"id":"pl-1","children":"warren-a"}', "pl-1")).toEqual([]);
		expect(parsePlanChildren('{"id":"pl-1","children":123}', "pl-1")).toEqual([]);
		expect(parsePlanChildren('{"id":"pl-1","children":null}', "pl-1")).toEqual([]);
		expect(parsePlanChildren('{"id":"pl-1","children":{"nested":true}}', "pl-1")).toEqual([]);
	});

	test("returns an empty array for an empty children array", () => {
		expect(parsePlanChildren('{"id":"pl-1","children":[]}\n', "pl-1")).toEqual([]);
	});

	test("filters out non-string and empty-string child entries", () => {
		const body =
			'{"id":"pl-1","children":["warren-a",123,null,true,{"x":1},["b"],"","warren-b"]}\n';
		expect(parsePlanChildren(body, "pl-1")).toEqual(["warren-a", "warren-b"]);
	});
});
