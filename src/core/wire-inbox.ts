/**
 * The steering-inbox slice of the wire vocabulary (warren-3d0b, warren-3305),
 * split out of ./wire.ts for the file-size budget. `src/core/wire.ts`
 * re-exports everything here, so consumers keep importing from
 * `src/core/wire.ts`. `src/core/` imports nothing — this module must stay
 * dependency-free.
 */

/**
 * Steering-message priority classes for the `run_inbox` table (warren-3d0b,
 * pl-829f step 18). Mirrors the seam's `MessagePriority`
 * (`src/runtime/contract.ts`) verbatim so the K8sProvider forwards the
 * contract value straight onto a row. Ordering is `urgent > high > normal >
 * low`; the poll endpoint claims priority-desc then FIFO-by-`seq` within a
 * class. TS-only narrowing — no SQL CHECK (mx-2ab984).
 */
export const INBOX_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type InboxPriority = (typeof INBOX_PRIORITIES)[number];

/**
 * Delivery lifecycle for a `run_inbox` row (warren-3d0b). Mirrors the seam
 * `Message.state` union: a fresh steering message is `unread`; the in-pod
 * poll (`GET /runs/:id/inbox`) atomically flips claimed rows to `delivered`;
 * `failed` is reserved for a delivery that could not be completed. TS-only
 * narrowing.
 */
export const INBOX_STATES = ["unread", "delivered", "failed"] as const;
export type InboxState = (typeof INBOX_STATES)[number];

/**
 * Steering-consumption capability declared on an agent definition
 * (`frontmatter.steering`, warren-3305). It answers "can this harness act on
 * a steering message sent to a RUNNING run?" — per-harness truth, not assumed
 * uniform:
 *
 *   - `"mid-run"`    — the harness consumes steering while a run is in
 *     flight (a live stdin channel the agent reads between/within turns).
 *     No builtin runtime qualifies today: pi's rpc read loop only consumes
 *     stdin at a turn boundary and warren closes stdin at pi's terminal
 *     `agent_end`, so a mid-turn write is never read (the warren-3305 live
 *     incident). Reserved for a future pi `steer`/`follow_up` rpc command.
 *   - `"spawn-only"` — steering is only consumed when drained BEFORE the
 *     agent process spawns (the runtime's `encodeInboxMessage` folds pending
 *     messages into the prompt). All eight builtins are here: pi and claude-code
 *     both fold at spawn and neither consumes mid-run. `POST
 *     /runs/:id/steer` against a running run with this capability fails 409
 *     instead of silently recording `steer.sent` for a message no one reads.
 *   - `"none"`       — the harness has no steering channel at all; every
 *     steer is rejected 409.
 *
 * An agent that declares NOTHING is legacy fail-open (steering allowed, as
 * before the flag existed) — the capability gate only constrains agents that
 * opt into a declaration. TS-only narrowing — no SQL CHECK (mx-2ab984).
 */
export const STEERING_CAPABILITIES = ["mid-run", "spawn-only", "none"] as const;
export type SteeringCapability = (typeof STEERING_CAPABILITIES)[number];
