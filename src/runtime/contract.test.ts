/**
 * The runtime seam's vocabulary must stay DERIVED from `src/core/wire.ts`
 * (warren-7b7a). `check:wire-types` matches on names, so an aliased second
 * spelling — `RunPhase` for `RunState`, `MessagePriority` for `InboxPriority` —
 * is invisible to it. These assertions are the mechanical stand-in: they fail to
 * compile the moment either side grows or loses a member.
 */

import { describe, expect, test } from "bun:test";
import {
	EVENT_STREAMS,
	INBOX_PRIORITIES,
	INBOX_STATES,
	type InboxPriority,
	type InboxState,
	RUN_STATES,
	type RunState,
} from "../core/wire.ts";
import type { Message, MessagePriority, NormalizedEvent, RunPhase } from "./contract.ts";

/** Compile-time mutual assignability: `A extends B` and `B extends A`. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

function assertExact<T extends true>(_witness: T): void {
	/* type-level only */
}

describe("runtime contract vocabulary", () => {
	test("derives RunPhase from the canonical RunState", () => {
		assertExact<Exact<RunPhase, RunState>>(true);
		const phases: RunPhase[] = [...RUN_STATES];
		expect(phases).toEqual([...RUN_STATES]);
	});

	test("derives MessagePriority from the canonical InboxPriority", () => {
		assertExact<Exact<MessagePriority, InboxPriority>>(true);
		const priorities: MessagePriority[] = [...INBOX_PRIORITIES];
		expect(priorities).toEqual([...INBOX_PRIORITIES]);
	});

	test("derives Message.state from the canonical InboxState", () => {
		assertExact<Exact<Message["state"], InboxState>>(true);
		const states: Message["state"][] = [...INBOX_STATES];
		expect(states).toEqual([...INBOX_STATES]);
	});

	test("derives NormalizedEvent.stream from the canonical EVENT_STREAMS plus null", () => {
		const streams: NormalizedEvent["stream"][] = [...EVENT_STREAMS, null];
		expect(streams).toEqual(["stdout", "stderr", "system", null]);
	});
});
