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
3. Fill in a description of the vulnerability, including steps to reproduce if possible

### Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Initial assessment**: Within 7 days
- **Fix or mitigation**: Within 30 days for confirmed vulnerabilities

We will keep you informed of progress throughout the process.

## Scope

### V1 security posture (known limitations)

Documented, accepted for V1:

- **Single bearer token.** No rotation, no expiry, no revocation. Loss of `WARREN_API_TOKEN` = full access. Mitigation: rotate by editing `.env` / the cluster secret and bouncing the container.
- **Plaintext secrets in `.env`.** Standard for self-host. The operator owns filesystem perms (`chmod 600 .env`). On a cluster, a managed secret store (Kubernetes Secrets / cloud secret manager) encrypts at rest.
- **No HTTPS termination in warren.** TLS is the reverse proxy's job. Direct HTTP on a non-loopback address is a misconfiguration, and `warren doctor` warns.
- **Trust-the-socket between warren and burrow.** Burrow's unix socket has no auth. The in-container threat model is "warren is the only client." A third party with code execution inside the warren process has full burrow access. Warren and burrow share the container by design.
- **No CSRF protection on the UI.** UI calls warren's API with the bearer token. Not exposed to third-party origins (CORS strict). Single-user posture.

### V1 non-goals (security-relevant)

- No multi-tenant auth, no per-user RBAC in V1. Single bearer token, one user. Multi-user identity via OIDC is on the post-V1 roadmap (R-09).
- No audit log in V1. Warren plans an append-only dispatch/steer/cancel/secret-read ledger post-V1 (R-16). It lands alongside R-09 since it depends on real user identity.
- No GitHub App auth in V1 — shared PAT via `GITHUB_TOKEN`. Warren plans GitHub App auth with installation-scoped tokens and per-repo allowlists post-V1 (R-18).

These are limitations for V1, not bugs. V2 candidates: token-pair (read/write), per-token scopes, audit log.

If you find a vulnerability outside this list, report it through the process above and we'll triage it.
