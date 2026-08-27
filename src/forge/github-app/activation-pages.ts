/**
 * Server-rendered pages for the OPT-IN App credential store path
 * (warren-b504, plan pl-26f3 step 7).
 *
 * The default (store-not-armed) pages live in `./registration.ts` and
 * stay byte-identical. These pages render the armed deployment's
 * equivalents: no env blocks, no "copy these now" — the flow ends with
 * "warren stored the credential" and a link back to the UI.
 *
 * Never render the stored private key here: the operator can read the
 * file under the data dir, and the page does not need to carry the
 * secret a second time.
 */

import { renderRegistrationChrome } from "./page-chrome.ts";
import { escapeHtml, type GitHubAppRegistration } from "./registration.ts";

function page(title: string, body: string): string {
	return renderRegistrationChrome(escapeHtml(title), body);
}

/**
 * The callback page for an armed store: the App half (id + PEM) is
 * persisted, and the one remaining step is installing the App. The
 * stored path is named so the operator knows where the secret lives and
 * how to revoke it.
 */
export function renderStoredCredentialsPage(
	registration: GitHubAppRegistration,
	credentialPath: string,
): string {
	const installUrl = `https://github.com/apps/${registration.slug}/installations/new`;
	const body = `<h1>App registered: ${escapeHtml(registration.name)}</h1>
<p><strong>warren stored the App credential</strong> (App id ${escapeHtml(String(registration.appId))}
and the private key) at
<code>${escapeHtml(credentialPath)}</code> with mode <code>0600</code>.
The client id and client secret are not needed and were not stored.</p>
<h1>One step left: install the App</h1>
<p>The credential triple still needs the installation id, which only exists
once the App is installed. Open
<a href="${escapeHtml(installUrl)}">${escapeHtml(installUrl)}</a>
and pick the account/repos warren may touch. When the install finishes GitHub
returns you here and warren <strong>activates the App forge immediately</strong>
— no restart, no env vars to paste. If the redirect cannot reach this warren,
rerun the install; the manual env-var path is always available by unsetting
<code>WARREN_APP_CRED_STORE</code> and re-registering.</p>
<p class="note">To revoke warren's access, delete the credential file above
and uninstall the App in your GitHub account settings (see SECURITY.md).</p>`;
	return page("GitHub App stored", body);
}

/**
 * The post-install page for an armed store: the triple is complete, it is
 * persisted, and the App forge is live in-process. Link back to the UI.
 */
export function renderActivatedPage(input: {
	readonly appId: string;
	readonly installationId: string;
	readonly credentialPath: string;
	readonly uiUrl: string;
}): string {
	const body = `<h1>Connected — warren is using the App</h1>
<p>The GitHub App forge is <strong>active now</strong>, with no restart and no
env vars. Stored credential (App id ${escapeHtml(input.appId)}, installation id
${escapeHtml(input.installationId)}, private key) at
<code>${escapeHtml(input.credentialPath)}</code>, mode <code>0600</code>.</p>
<p><a href="${escapeHtml(input.uiUrl)}">Back to the warren UI</a> and dispatch
a run — pushes and PRs go through the App from here on.</p>
<p class="note">Boot prefers this stored credential whenever the
<code>WARREN_GITHUB_APP_*</code> env vars are absent, so restarts keep App
mode too. To revoke: delete the credential file and uninstall the App (see
SECURITY.md).</p>`;
	return page("GitHub App connected", body);
}

/**
 * The post-install page when the store is armed and the App half is
 * stored, but this visit carries no readable installation id — the
 * manual fallback. Distinct from the not-armed page: warren already
 * holds the App half, so the operator only needs to bring the id home.
 */
export function renderInstalledMissingIdPage(credentialPath: string): string {
	const body = `<h1>Installation id not on this URL</h1>
<p>warren has the App credential stored (${escapeHtml(credentialPath)}), but
GitHub's redirect carried no <code>installation_id</code> warren could read,
so the triple is still incomplete and the App forge is NOT active yet.</p>
<p>Find the id under your account's <code>Settings &rarr; Applications &rarr;
Configure</code> (the URL reads <code>.../settings/installations/&lt;id&gt;</code>).
Revisit this page as
<code>/github-app/installed?installation_id=&lt;id&gt;</code> and warren
completes the triple and activates the forge.</p>
<p class="note">Alternatively, unset <code>WARREN_APP_CRED_STORE</code>, restart,
and re-register to use the manual env-var path.</p>`;
	return page("Installation id missing", body);
}
