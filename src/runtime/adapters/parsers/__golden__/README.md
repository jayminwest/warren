# pi RPC golden traces

> Ported verbatim from burrow's `src/runtime/parsers/__golden__/`
> (warren-7933, plan pl-3007). The regeneration procedure below is
> burrow's historical record; in warren the canonical goldens are
> re-blessed with `WARREN_UPDATE_PI_GOLDEN=1 bun test
> src/runtime/adapters/parsers/pi-handshake.test.ts`.

Real `pi --mode rpc` stdout captures used by the pi parser unit tests
(`burrow-d949`) and the RPC handshake compatibility test (`burrow-988b`).
Source seed: `burrow-01f7`. Refreshed to pi 0.78.1 with extension-enabled
captures in `burrow-f395` (Leveret pi-chat slice, plan `pl-1ee7`).

## Pinned environment

- pi version: **0.78.1** (from `pi --version`)
- Provider: `anthropic`
- Model: `claude-haiku-4-5`
- Auth: explicit `--api-key $ANTHROPIC_API_KEY`, OR a populated
  `~/.pi/agent/auth.json` OAuth session (see "Auth precedence" below). The
  0.78.1 captures used the stored OAuth path; the wire shape is identical.
- pi flags applied to the 0.78.1 captures:
  `--mode rpc --no-session --provider anthropic` — note **no
  `--no-extensions`** (extensions are enabled, the pi-chat contract). The
  0.74.0 captures were taken with `--no-extensions`.

## Fixtures

The `0.74.0` fixtures predate the pi-chat work and are retained because the
dispatcher tests (`src/runner/dispatcher.test.ts`) and the
`.devcontainer/Dockerfile` pin still reference pi 0.74.0. The `0.78.1`
fixtures are the current host-version captures with extensions enabled.

| File | Tools? | Extensions | Turns | Covers |
|------|--------|-----------|-------|--------|
| `pi-v0.74.0-anthropic-success.jsonl` | `--no-tools` | off | 1 | response · agent_start · turn_start · message_start/end (user) · message_start · message_update (thinking_start/delta/end, text_start/delta/end) · message_end · turn_end · agent_end |
| `pi-v0.74.0-anthropic-tools.jsonl`   | `--tools ls,read` | off | 2 | All of the above plus message_update (toolcall_start/delta/end) · tool_execution_start · tool_execution_end · message_start/end (role=`toolResult`) |
| `pi-v0.78.1-anthropic-success.jsonl` | `--no-tools` | on | 1 | Same lifecycle as the 0.74.0 success trace, captured against 0.78.1 |
| `pi-v0.78.1-anthropic-tools.jsonl`   | `--tools ls,read` | on | 2 | Same as the 0.74.0 tools trace, captured against 0.78.1 |
| `pi-v0.78.1-anthropic-extension-ui.jsonl` | `--tools ls,read` | on (`-e confirm-ext.ts`) | 2 | Tools trace plus a **real `extension_ui_request`** (`method:"select"`) emitted mid-tool-call by a `ctx.ui.select(...)` extension; the capture driver auto-declines it the way the `pi-chat` runtime does (`{type:"extension_ui_response", id, cancelled:true}`), so the run reaches `agent_end` instead of blocking |

### 0.78.1 vocabulary deltas vs 0.74.0

- `agent_end` now carries a boolean **`willRetry`** field (absent in
  0.74.0). The parser preserves it verbatim in `payload`; the handshake
  test asserts the presence delta.
- `extension_ui_request` has the shape
  `{type, id, method, title, options?/message?/...}` — `method` is one of
  `select | confirm | input | editor | notify | setStatus | setWidget |
  setTitle | set_editor_text` (see pi's `RpcExtensionUIRequest`). The
  captured fixture uses `method:"select"`.

Event types **not** present in any fixture (rare/exceptional events the
parser must still handle): `queue_update`, `compaction_start`,
`compaction_end`, `auto_retry_start`, `auto_retry_end`, `extension_error`.
The parser unit tests (`burrow-d949`) exercise these with hand-crafted
envelopes derived from pi's RPC spec — same pattern as
`jsonl-claude.test.ts`.

## Observed wire-shape facts

1. **RPC framing** — Each line is a single JSON object terminated by `\n`.
   No length prefix. No comment lines. Empty lines do not appear in
   either capture.
2. **First event is always** `{"type":"response","command":"prompt","success":true}`
   — pi's acknowledgement of the inbound RPC command. Burrow's parser
   maps this to `state_change` on the `system` stream.
3. **Assistant content is delta-streamed** via `message_update` envelopes
   whose `assistantMessageEvent.type` is one of
   `thinking_start | thinking_delta | thinking_end | text_start | text_delta | text_end | toolcall_start | toolcall_delta | toolcall_end`.
   The terminal `message_end` envelope carries the fully assembled
   `content[]` array (a superset of what the per-update events carry), so
   the parser can rely on `message_end` alone for canonical block content
   and treat `message_update` as best-effort streaming telemetry.
4. **Tool results are messages, not content blocks.** Unlike claude-code
   (which wraps tool results as `{type:"tool_result"}` inside a `user`
   message's `content[]`), pi emits a dedicated `message_start` /
   `message_end` pair with `message.role === "toolResult"` after each
   `tool_execution_end`.
5. **stopReason on errors** — When the provider returns a 4xx, pi still
   emits the full `message_start` → `message_end` → `turn_end` →
   `agent_end` envelope chain, with `stopReason:"error"` and a string
   `errorMessage` field carrying the upstream error body. The assistant
   `content[]` array is empty in that case.

## Critical dispatcher invariant (deviation from claude-code)

**pi exits the instant stdin closes**, even mid-inference. A naive
"write prompt blob then close stdin" (the claude-code pattern in
`src/runner/dispatch.ts:114-148`) produces a five-line trace and an
exit code 0 with no assistant content. To get a complete run the
dispatcher must hold stdin open until `agent_end` arrives on stdout
(or write a `{"type":"exit"}` RPC command, if pi defines one — see
follow-up).

This contradicts plan `pl-5198` risk #9, which assumed parity with
claude-code's "stdin-close finishes inference" semantics. Step 3
(`burrow-4a3b`, build `src/runtime/pi.ts`) must wire the stdin-hold
contract explicitly. Both fixtures here were captured with
`(echo '<prompt>'; sleep 30) | pi …` for exactly this reason.

## Auth precedence (also a runtime hazard)

On a host with `~/.pi/agent/auth.json` populated (i.e. the user has
run `pi /login`), pi prefers the stored OAuth token over the
`ANTHROPIC_API_KEY` env var. Only an explicit `--api-key <value>` argv
flag overrides the OAuth path. Plan note: inside the burrow sandbox
`~/.pi` is not bind-mounted, so the env-var path will win there by
default; in host-mode dev, this is a footgun worth documenting in
the runtime's prepare/install check.

## Regenerating

All fixtures were produced in a scratch directory (`/tmp/pi-fixture-test`).
Auth resolves via either `--api-key "$ANTHROPIC_API_KEY"` (a billed API key,
not a Pro/Plus OAuth token) or a populated `~/.pi/agent/auth.json` OAuth
session. The `sleep N` holds stdin open so pi can finish inference before
EOF (see "Critical dispatcher invariant" above).

### 0.78.1 (current, extensions enabled)

```bash
# Success-path (no tools)
(echo '{"type":"prompt","message":"Reply with exactly the single word: ack."}'; sleep 30) \
  | pi --mode rpc --no-session \
       --provider anthropic --model claude-haiku-4-5 --no-tools \
  > pi-v0.78.1-anthropic-success.jsonl

# Tool-using (two turns: ls call + final text)
mkdir -p ws && echo alpha > ws/a.txt && echo beta > ws/b.txt && cd ws
(echo '{"type":"prompt","message":"List the files in the current directory using the ls tool, then reply with exactly the JSON: {\"done\":true} and stop."}'; sleep 60) \
  | pi --mode rpc --no-session \
       --provider anthropic --model claude-haiku-4-5 --tools ls,read \
  > pi-v0.78.1-anthropic-tools.jsonl
```

The `extension_ui_request` capture needs an extension that calls a UI
method plus a driver that answers the request (a bare `echo | pi` cannot
reply mid-stream, so pi would block). The driver mirrors the `pi-chat`
runtime: it auto-declines every `extension_ui_request` with
`{type:"extension_ui_response", id, cancelled:true}`.

```ts
// confirm-ext.ts — emits a select UI request on each ls tool call
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "ls" || !ctx.hasUI) return undefined;
    const choice = await ctx.ui.select(
      `Allow ls on ${String(event.input.path ?? ".")}?`,
      ["Yes", "No"],
    );
    return choice === "Yes" ? undefined : { block: true, reason: "Blocked by user" };
  });
}
```

```ts
// drive.ts — spawn pi, stream stdout to the fixture, auto-decline UI requests
const proc = Bun.spawn(["pi", ...Bun.argv.slice(3)], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
proc.stdin.write(`${JSON.stringify({ type: "prompt", message: "Use the ls tool, then reply done." })}\n`);
proc.stdin.flush();
const lines: string[] = [];
const reader = proc.stdout.getReader();
const dec = new TextDecoder();
let buf = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    lines.push(line);
    const env = JSON.parse(line);
    if (env.type === "extension_ui_request")
      proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: env.id, cancelled: true })}\n`), proc.stdin.flush();
    if (env.type === "agent_end") proc.stdin.end();
  }
}
await proc.exited;
await Bun.write(Bun.argv[2], `${lines.join("\n")}\n`);
```

```bash
mkdir -p ws && echo alpha > ws/a.txt && cd ws
bun ../drive.ts ../pi-v0.78.1-anthropic-extension-ui.jsonl \
  --mode rpc --no-session --provider anthropic --model claude-haiku-4-5 \
  --tools ls,read -e ../confirm-ext.ts
```

After (re)capturing, re-bless the canonical goldens and review the diff:

```bash
BURROW_UPDATE_PI_GOLDEN=1 bun test src/runtime/parsers/pi-handshake.test.ts
```

### 0.74.0 (legacy, `--no-extensions`)

Retained for the dispatcher tests and the devcontainer pin. Same commands
as above but with `--no-extensions` and `--api-key "$ANTHROPIC_API_KEY"`,
written to `pi-v0.74.0-anthropic-{success,tools}.jsonl`.

Volatile fields (`timestamp`, `responseId`, `request_id`, `thinkingSignature`,
`toolCallId`, the `extension_ui_request` `id`, and the `id` inside `toolCall`
content blocks) differ between captures. The handshake test (`burrow-988b`)
canonicalizes these before comparing — the fixture bytes themselves are not
byte-stable across regenerations.
