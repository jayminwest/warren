# Golden fixtures for the cross-fork PR intent

`openclaw-pr-intent.json` pins the exact upstream pull-request request the
campaign controller renders for the canonical OpenClaw dry-run scenario
(approved `camp-openclaw-eod-v0`, succeeded run `seq-1` on branch
`warren/issue-812` of the `warren-run-bot` fork, issue #812). The digest is
over the canonical JSON of the request body — the same digest journaled as
the `pr_intent` action's `request_digest`.

The request is evidence only: V0 has no GitHub mutation transport, so this
request can never be posted. Regenerate with:

```bash
WARREN_UPDATE_GOLDENS=1 bun test src/pr-intent/intender.test.ts
```
