# @warren-ext/tracker-conformance

The **warren-tracker/v1 conformance suite** plus **FakeTracker**, the
reference in-memory server (warren-53ea). This package is the
falsification test for warren's issue-tracker wire protocol
(docs/PHILOSOPHY.md rule 4): a tracker integration is proven by
surviving this suite, not by inspection.

> **Status: EXPERIMENTAL.** warren-tracker/v1 is versioned and
> documented, but it is not a stable contract until a *foreign*
> implementation survives this suite unchanged. If you are that foreign
> implementation: run the suite, and report what it made you change.

## What's here

- `src/protocol.ts` — the published wire vocabulary (endpoints,
  response shapes, the `issue_not_found` error code, the capability
  flags). A deliberate, self-contained copy of warren's canonical
  declaration: this is the document a tracker author codes against.
- `src/conformance.ts` — the suite. Exercises capability discovery and
  protocol-version negotiation (a wrong version is rejected outright),
  the base contract (issue reads, the raw status map, **idempotent
  close**), the not-found taxonomy (`error.code: "issue_not_found"` on
  read and close), and the optional surfaces (plans, metadata with
  shallow-merge/null-clear semantics, scheduled issues) gated on the
  capabilities the server declares.
- `src/fake-tracker/` + `src/fake-tracker.ts` — FakeTracker, the
  reference server. In-memory, seeded from a JSON fixture, with a
  state-file mirror so another process can assert what it observed.
- `src/check.ts` — the CLI a foreign implementation runs.

## Run the suite against your server

Seed your tracker with at least one issue (add a plan and a scheduled
issue for full optional-surface coverage), then:

```bash
bun install
bun run check http://localhost:8080            # or: bun run src/check.ts <url>
bun run check http://localhost:8080 --bearer <token>
```

Exit code 0 means your server conforms. Every failure prints the case
name and what the protocol required instead.

## Run the FakeTracker reference server

```bash
bun run start -- --port 8080 --fixture fixture.json --state-file mirror.json
# in docker:
docker build -t warren-ext-tracker-conformance .
docker run --rm -p 8080:8080 warren-ext-tracker-conformance
```

Fixture shape:

```json
{
  "issues": [
    { "id": "ext-1", "status": "open", "title": "probe",
      "scheduledFor": "2026-09-01T00:00:00.000Z" }
  ],
  "plans": [
    { "id": "pl-1", "status": "active", "children": ["ext-1"] }
  ]
}
```

Flags: `--port` (0 = ephemeral; the bound port prints as
`fake-tracker listening on <port>`), `--fixture`, `--state-file`,
`--bearer` (require a token), `--protocol-version` (override — only for
the suite's wrong-version case), `--no-plans`, `--no-metadata`,
`--no-scheduled-issues`, `--git-native`.

Statuses are **raw tracker strings** — warren normalizes them onto its
own three-state vocabulary at its bridge. Close is idempotent: closing
an already-closed issue returns 200, closing an unknown id returns 404
with `error.code: "issue_not_found"`.

## Tests

```bash
bun test          # the suite, run against the reference server in-proc
bun run typecheck
```

## Friction

Building this package surfaced no missing warren surface: the protocol
vocabulary plus one HTTP endpoint set is the whole contract. The one
deliberate copy is `src/protocol.ts` (the extension seam forbids
importing warren internals); the suite itself is what keeps the two
copies honest.
