# Golden response envelopes

Stable wire-shape fixtures for warren's HTTP error and meta responses
(warren-8aa4 / pl-7b06 step 22).

Each `*.json` file in this directory captures the exact
`{ status, body }` produced by `src/server/errors.ts` (`renderError`,
`notFound`, `methodNotAllowed`, `notImplemented`) for one canonical
input. The companion test `src/server/responses.golden.test.ts`
rebuilds each case from its `produce()` closure and asserts deep
equality against the file on disk.

These fixtures are the canonical wire contract. Any change to status
codes, error codes, hint behaviour, or envelope shape MUST update them
deliberately — downstream consumers (warren `Client`, `cn`/`mulch`
SDKs, dashboards) decode against this shape and silently breaking
their decoder is worse than failing a test.

## Regenerating

```bash
WARREN_UPDATE_GOLDENS=1 bun test src/server/responses.golden.test.ts
```

Review the diff with `git diff src/server/__golden__/` and commit only
the changes you actually intended. A noisy diff (e.g. every case
churned because of a JSON-stringify formatting tweak) is the signal to
roll the change back and stabilise the producer instead.

## Why `__golden__/`

The directory name mirrors the
[burrow parser golden fixtures](https://github.com/jayminwest/burrow)
convention (`burrow/src/runtime/parsers/__golden__/`) and is
already excluded from `check:file-sizes`, `check:debt-markers`,
`check:duplicates`, and Biome's filename-convention rule (see
`scripts/check-file-sizes.ts`, `scripts/check-debt-markers.ts`,
`.jscpd.json`, `biome.json`). New golden directories under `src/`
should follow the same name so those exclusions keep working.
