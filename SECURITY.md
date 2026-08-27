# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |

Only the latest release on the current major version line receives security updates.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/jayminwest/warren/security/advisories).

1. Go to the [Security Advisories page](https://github.com/jayminwest/warren/security/advisories)
2. Click **"New draft security advisory"**
3. Describe the vulnerability and include steps to reproduce it when possible

### Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Initial assessment**: Within 7 days
- **Fix or mitigation**: Within 30 days for confirmed vulnerabilities

We will keep you informed of progress throughout the process.

## Current security posture

Warren serves one operator or trusted team per deployment. The deployment, not an individual user account, is the trust boundary.

- **Shared operator token.** `WARREN_AUTH=token`, the default, protects operator routes with one bearer token. The token has no expiry, scopes, or independent revocation. Rotate it by changing the deployment secret and restarting warren. Loss of the token grants operator access.
- **Optional public-read mode.** `WARREN_AUTH=public` admits unauthenticated spectators to an allowlisted, redacted projection. Mutations and operator-only fields still require the bearer token. A malformed supplied token returns 401 rather than falling back to spectator access. Only use this mode when every registered repository and exposed prompt is safe to publish.
- **No named users or per-user RBAC.** Warren does not attribute operator actions to distinct people. A team that shares an instance also shares its deployment trust boundary. Put an identity-aware proxy in front when the deployment needs external access control.
- **TLS stays at the edge.** Warren serves HTTP. A reverse proxy or cluster ingress must provide TLS before exposing it outside a trusted network. `warren doctor` warns about unsafe non-loopback deployments.
- **Secrets follow the deployment boundary.** A single-box install commonly reads secrets from `.env`. Protect that file with host permissions. Kubernetes deployments should use cluster or cloud secret management. Run pods and containers do not receive the database credential.
- **Run sandboxes do not receive the operator token.** Warren mints a run-scoped callback token for each live run. It reaches only that run's inbox, finalize, salvage, and git-credential remint routes, and the server rejects it after the run becomes terminal. The git-credential remint (`POST /runs/:id/git-credential`) is the App-mode K8s path: the pod cannot hold an expiring installation token, so it asks the control plane to mint a fresh push credential over this authenticated callback channel; the mint returns a forge-scoped credential and never widens the caller's own token (warren-5a5c).

## Runtime isolation

Warren owns its sandbox and runtime implementations. It has no Burrow daemon, socket, or package dependency.

- **`local`.** Warren creates a fresh worktree and runs the harness under `bwrap` on Linux or `sandbox-exec` on macOS. The Linux container topology requires the security settings in `docker-compose.yml` so nested user namespaces can start.
- **`docker`.** Each run uses a sibling container. The warren service mounts the Docker socket, which grants control of the Docker daemon. Treat the control-plane container as trusted operator infrastructure and never expose that socket to an agent container.
- **`k8s`.** Each run uses a pod as its isolation boundary. Kubernetes RBAC separates control-plane access from run-pod permissions. Resource and admission limits reduce the effect of runaway workloads, but operators still own cluster policy and secret configuration.

Isolation limits damage from an agent process. It does not make untrusted repository code safe to run with unrestricted credentials or network access. Review the selected runtime capabilities and project-specific agent image before dispatching against untrusted code.

## Forge credentials

GitHub access sits behind the `Forge` seam.

- `WARREN_FORGE=github` uses a static PAT from `GITHUB_TOKEN`.
- `WARREN_FORGE=app` uses a GitHub App and mints short-lived installation tokens for forge and Git operations.

The control plane supplies Git credentials for clone, fetch, push, and pull-request operations. Configure the narrowest repository access that the deployment needs. Agent commit attribution is separate: set `WARREN_GIT_AUTHOR_NAME` and `WARREN_GIT_AUTHOR_EMAIL` to a dedicated machine-account identity.

### Opt-in App credential store (warren-b504)

By default the GitHub App manifest flow (`/github-app/register`) persists nothing — the credential set renders once and the operator pastes it into their secret store.

Setting `WARREN_APP_CRED_STORE=data-dir` opts a deployment in. Warren stores the App credential triple (App id, installation id, private key) at `<WARREN_DATA_DIR>/github-app-credentials.json`. The file mode is `0600` and the parent directory is `0700`. Once the installation completes, warren activates the App forge in-process with no restart. Boot prefers the stored triple whenever the `WARREN_GITHUB_APP_*` env vars are absent. Restarts keep App mode.

- **Opt-in only.** The default posture keeps no copy. The pages stay as they were. `WARREN_AUTH=public` instances refuse the store outright. Boot fails loud in that case.
- **The private key is never logged** and never re-rendered on any page.
- **To revoke:** delete the credential file and uninstall the App under your GitHub account's `Settings → Applications`. Then restart warren, or unset the env var to fall back to the manual flow.

## Browser and preview boundaries

### One-time setup code handoff (warren-48f8)

`warren up` can open the operator's browser at `GET /setup?code=<code>`.
The browser then lands in the UI with the operator session already active.
The setup code is 32 crypto-random bytes that lives ten minutes and redeems
exactly once.

Only a boot that opts in mints a code (`warren up`, never `warren serve`).
The long-lived operator token never rides the URL. Only the throwaway code
does. The redemption page writes the token to the SPA's existing
localStorage key, then redirects to `/`.

- **Never on `WARREN_AUTH=public`.** The handoff never arms under public
  auth. `/setup` answers 404 there.
- **Never under `--no-auth`.** No token exists to hand off.
- **A spent or expired code answers 400.** This also covers a replay from
  browser history. The error page points at the UI login.

The UI stores the operator bearer in the warren origin and does not provide separate CSRF protection. Strict CORS and the single-deployment-token model are part of this posture. Do not serve untrusted content on the UI origin.

Preview environments run repository code and therefore use a separate browser origin on supported TCP deployments.

- **Path mode is the default.** Warren serves previews from a dedicated listener on `WARREN_PREVIEW_PORT`, normally the API port plus one. The main UI origin redirects `/p/<run-id>/` to that listener. Publish and proxy the second port.
- **Subdomain mode is opt-in.** `WARREN_PREVIEW_MODE=subdomain` requires `WARREN_PREVIEW_HOST`, wildcard DNS, and a wildcard TLS certificate.
- **Unix-socket exception.** A unix-only deployment cannot create the dedicated TCP listener and retains legacy same-origin path behavior. Warren warns at boot. Use subdomain mode when previews can run untrusted code.

The preview proxy strips `Authorization` and `Cookie` before forwarding a request to the preview application. Signed preview cookies authorize browser access to a specific run and mode.

## Run records and optional extensions

Core warren persists run state and structured events. Those records can contain prompts, tool inputs, file paths, costs, and repository metadata. Restrict database, backup, log, and API access accordingly. Public-read mode serves a narrower projection, not the operator record.

The append-only audit log and automated judge are optional, out-of-process extensions. A base installation does not launch them. Each extension owns its storage, credential, retention, and deployment security. Installing the judge can send run material to its configured model provider.

If you find a vulnerability outside this documented posture, report it through the process above and we will triage it.
