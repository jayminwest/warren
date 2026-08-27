# First run

This guide takes a fresh macOS or Linux machine from no warren installation to a completed run with a pushed branch. One install command and one boot command do the work. Operators who deploy with Compose or Kubernetes should read the [Docker self-host guide](self-host/docker.md) and the [Kubernetes runbook](RUNBOOK-K8S.md) instead.

## Requirements

- A macOS or Linux machine with a shell and a browser.
- A model credential: a Claude subscription or an Anthropic API key.
- A GitHub account warren can open a pull request from.

The install script installs Bun and the `warren` CLI when they are missing. No sudo. Everything stays under user-local paths.

## Install

```bash
curl -fsSL https://warren.run/install | sh
```

That lands `warren` on your PATH and prints the next step, `warren up`. To pin a version or install a local build, read the env knobs (`WARREN_INSTALL_VERSION`, `WARREN_INSTALL_TARBALL`) at the top of [`scripts/install.sh`](https://github.com/jayminwest/warren/blob/main/scripts/install.sh).

## Start warren

```bash
warren up
```

`warren up` runs a preflight, picks the sandbox runtime for your machine, and boots the server in the foreground:

- macOS uses the local runtime with `sandbox-exec`.
- Linux with `bwrap` on PATH uses the local runtime.
- Linux without a native sandbox prints Compose guidance instead, and you follow the [Docker self-host guide](self-host/docker.md).

The data directory defaults to `~/.warren/data` and holds the database, clones, and workspaces. `warren up` logs the CLI into the new instance automatically, so you never copy a token by hand.

Pass `--no-open` to skip the browser and keep the printed setup URL. Pass `--no-wizard` to skip the credential prompts. The wizard also skips itself when stdin is not a terminal.

### Model credential

On a machine with no model credential, the wizard asks for one:

- **Claude subscription.** The wizard offers `claude setup-token` when the `claude` CLI is on PATH, or accepts a pasted `CLAUDE_CODE_OAUTH_TOKEN`. Subscription auth serves the claude-code harness only. Other harnesses still need their own API keys.
- **Anthropic API key.** Paste an `ANTHROPIC_API_KEY`. This path serves every harness.

Runs under subscription auth show an estimate badge in the UI instead of a billed cost. Warren still enforces `maxCostUsd` against that estimate as a runaway brake.

### GitHub credential

The wizard reuses a `gh auth token` when it detects one, or accepts a pasted token. The wizard treats this as a bootstrap. The GitHub App flow below is the durable path.

The wizard stores accepted values in `~/.warren/env` with mode 0600. Real environment variables always win over that file. Read [Credentials](credentials.md) for the full picture.

### Browser handoff

After boot, `warren up` opens your browser on a one-time setup URL. The browser lands in the UI with your operator session already active. The setup code expires after ten minutes and redeems exactly once. When the browser does not open, copy the printed URL by hand.

## First run in the browser

A fresh instance shows a setup checklist instead of an empty console:

1. **Connect GitHub.** The GitHub App flow walks you through a manifest registration on your GitHub account. This is the default forge path. Grant it access to the repositories warren will operate on.
2. **Add a repo.** The project picker lists the repositories your App installation can see. Select one and warren registers it.
3. **Dispatch the starter run.** The checklist offers a prefilled low-risk task. Start it and watch the event stream.

A successful run finalizes its workspace and pushes the run branch under the `warren/` prefix. Warren opens a pull request when the forge and project configuration permit it. The pushed branch is the kernel's guaranteed delivery boundary.

## Stop and restart

`warren up` runs the server in the foreground. Stop it with Ctrl-C. Restart with `warren up` again. Run state, projects, and credentials persist under `~/.warren/`, so the instance resumes where it stopped.

## Dispatch from the shell

The CLI is already logged in. These commands work without further setup:

```bash
warren projects
warren run -p "fix the failing test" <agent> <project-id>
```

Read the [CLI reference](cli-reference.md) for every command, flag, and exit code.

## Verify the deployment

```bash
curl http://localhost:8080/healthz
warren doctor
```

`/healthz` is an auth-free liveness probe. `warren doctor` checks reachability, authentication, and version compatibility from the client side.

## Next steps

- [Credentials](credentials.md) — the two model paths and the two GitHub paths in one page.
- [Configure a project](project-setup.md).
- [Operate the service](operations.md).
- [Use Docker or Kubernetes](self-host/docker.md).
- [Configure previews](previews.md).
- [Read the CLI reference](cli-reference.md).
