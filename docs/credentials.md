# Credentials

Warren needs two kinds of credential: one so an agent can call its model API, and one so warren can operate on GitHub. Each kind has two paths. This page states all four in one place.

- A casual install gets every credential through `warren up` and the browser onboarding. Read the [first-run guide](quickstart.md) for that flow.
- An operator deployment sets the same values through the environment. Read [`.env.example`](../.env.example) or the [Docker self-host guide](self-host/docker.md).

## Model credentials

### Claude subscription token

When the `claude` CLI is on PATH, the `warren up` wizard offers `claude setup-token` and stores the resulting `CLAUDE_CODE_OAUTH_TOKEN`. A pasted token works too.

Subscription auth serves the claude-code harness only. Pi and every other harness still need their own API keys. The wizard states this limit at the prompt, and the cost display honors it: runs under subscription auth carry `costBasis=subscription_estimate` and the UI shows the cost as an estimate, not a bill. `maxCostUsd` still enforces against that estimate as a runaway brake.

### Anthropic API key

An `ANTHROPIC_API_KEY` serves every harness. Set it directly for operator deployments:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Warren forwards it into the sandbox through the claude-code runtime profile, which also allows `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and `CLAUDE_CODE_OAUTH_TOKEN`. Other provider keys (OpenAI, Gemini, and others) ride the same per-runtime allowlist. Read [`.env.example`](../.env.example) for the list.

## GitHub credentials

### GitHub App (the default)

The GitHub App path is the default forge for a fresh install. During browser onboarding, the App manifest flow (`/github-app/register`) walks you through a registration on your GitHub account. GitHub then redirects back and warren completes the installation. The project picker lists the repositories your installation can see.

Credential persistence is opt-in:

- **Default: nothing persists.** The credential set renders once and you paste it into your secret store.
- **Opt-in: `WARREN_APP_CRED_STORE=data-dir`.** Warren stores the App credential triple (App id, installation id, private key) at `<WARREN_DATA_DIR>/github-app-credentials.json` with mode 0600 inside a 0700 directory. Warren activates the App forge in-process with no restart and prefers the stored triple when the `WARREN_GITHUB_APP_*` env vars are absent. `WARREN_AUTH=public` instances refuse this store outright.

Operator deployments configure the same forge through the environment with `WARREN_FORGE=app` and `WARREN_GITHUB_APP_ID`, `WARREN_GITHUB_APP_INSTALLATION_ID`, and `WARREN_GITHUB_APP_PRIVATE_KEY`. Read [Security](../SECURITY.md) for the full posture, including revocation.

### Static token (operator and CI path)

A static GitHub token is the operator path for container, CI, and mirror deployments:

```bash
GITHUB_TOKEN=ghp_...
```

The env var `WARREN_FORGE=github` selects this forge. A static credential never expires on its own, so plan a rotation cadence. Read [Making a repo warren-ready](project-setup.md) for why an App beats a static token for auto-merge workflows.

#### Machine-account identity

Set the Git author identity so agent commits attribute to a bot, not to a person:

```bash
WARREN_GIT_AUTHOR_NAME=your-bot-login
WARREN_GIT_AUTHOR_EMAIL=1234567+your-bot-login@users.noreply.github.com
```

Use a dedicated GitHub machine account and its noreply address. The two values are not secrets. When both are absent, warren warns and falls back to the host identity, which is usually unset in a fresh container. The `warren up` wizard derives both from your token's GitHub login when it collects a token interactively.

## Where warren stores credentials

- `~/.warren/env` — values the `warren up` wizard collects, mode 0600. Real environment variables always win over this file.
- `~/.warren/client.json` — base URL plus operator token for the CLI, mode 0600. Never a model or GitHub credential.
- `<WARREN_DATA_DIR>/github-app-credentials.json` — the opt-in App triple.

The wizard prints key names, never values. Rotate a stored credential by setting the environment variable or by deleting the stored line and running `warren up` again.
