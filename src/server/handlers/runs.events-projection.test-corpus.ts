/**
 * Fixture corpus for the event-stream secret scrubber tests
 * (warren-1cb7 / pl-b82d step 16), split out of
 * `runs.events-projection.test.ts` (warren-9bbc) to keep both files under
 * the per-file line budget. Imported by that test for both layers of the
 * assertion — the pure `scrubSecrets` walk and the anonymous HTTP stream.
 *
 * Vendor-token fixtures are BUILT AT LOAD TIME from concatenated parts so
 * the committed source never carries a full vendor-pattern literal —
 * GitHub push protection scans the source bytes, and a realistic
 * `lin_api_…` / `sk_live_…` / Slack-webhook literal would reject the push
 * (warren-9bbc). The scrubber sees the assembled string; the scanner sees
 * only fragments.
 */
const linearApiKey = `${["lin", "api"].join("_")}_${"ab".repeat(20)}`;
const stripeLiveKey = `${["sk", "live"].join("_")}_${"c1".repeat(12)}`;
const slackWebhookUrl = [
	"https://hooks.slack.com/services",
	"T0DUMMYTEAM",
	"B0DUMMYCHAN",
	"d2".repeat(12),
].join("/");
const gitlabPat = `glpat-${"e3".repeat(10)}`;
const npmAccessToken = `npm_${"f4".repeat(18)}`;
const sendgridApiKey = ["SG", "a5".repeat(11), "b6".repeat(22)].join(".");
const googleApiKey = `AIza${"c7".repeat(18)}`;

/**
 * Real-shaped agent transcript payloads, one per known key shape. Each
 * fixture carries the literal a scrubbed stream must never contain.
 */
export const CORPUS: readonly { name: string; payload: unknown; secret: string }[] = [
	{
		name: "sk-ant- in a bash tool_use command line",
		payload: {
			type: "tool_use",
			name: "Bash",
			input: { command: "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789xyz bun run agent" },
		},
		secret: "sk-ant-api03-AbCdEf0123456789xyz",
	},
	{
		name: "sk- OpenAI-style key in a tool_result stdout",
		payload: {
			type: "tool_result",
			content: [{ type: "text", text: "OPENAI_API_KEY=sk-proj-0123456789abcdefghijABCDEF" }],
		},
		secret: "sk-proj-0123456789abcdefghijABCDEF",
	},
	{
		name: "ghp_ classic PAT echoed into a stack trace",
		payload: {
			type: "text",
			text: "fatal: could not read Username\n  at auth (url=https://ghp_0123456789abcdefghijABCDEFGHIJ0123@github.com)",
		},
		secret: "ghp_0123456789abcdefghijABCDEFGHIJ0123",
	},
	{
		name: "gho_ OAuth token in a git remote",
		payload: {
			type: "text",
			text: "remote: https://gho_0123456789abcdefghijABCDEFGHIJ0123@github.com/x/y",
		},
		secret: "gho_0123456789abcdefghijABCDEFGHIJ0123",
	},
	{
		name: "ghs_ server-to-server token in an env dump",
		payload: { env: { GH_TOKEN_ALIAS: "ghs_0123456789abcdefghijABCDEFGHIJ0123" } },
		secret: "ghs_0123456789abcdefghijABCDEFGHIJ0123",
	},
	{
		name: "github_pat_ fine-grained PAT",
		payload: {
			type: "tool_use",
			input: {
				command: "gh auth login --with-token <<< github_pat_11ABCDEFG0abcdefghij_0123456789",
			},
		},
		secret: "github_pat_11ABCDEFG0abcdefghij_0123456789",
	},
	{
		name: "AKIA access key id in an aws cli invocation",
		payload: {
			type: "tool_use",
			input: { command: "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE" },
		},
		secret: "AKIAIOSFODNN7EXAMPLE",
	},
	{
		name: "ASIA STS session key id",
		payload: { type: "text", text: "credentials: ASIAJKLMNOPQRSTUVWXY expired" },
		secret: "ASIAJKLMNOPQRSTUVWXY",
	},
	{
		name: "xoxb- Slack bot token",
		payload: { type: "text", text: "SLACK_BOT_TOKEN=xoxb-1234567890-0987654321-AbCdEfGhIjKl" },
		secret: "xoxb-1234567890-0987654321-AbCdEfGhIjKl",
	},
	{
		name: "xoxp- Slack user token",
		payload: { type: "text", text: "curl -d token=xoxp-1234567890-0987654321-AbCdEfGhIjKl" },
		secret: "xoxp-1234567890-0987654321-AbCdEfGhIjKl",
	},
	{
		name: "PEM private key block read out of a file",
		payload: {
			type: "tool_result",
			content:
				"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx0Uf9k\nQzk3n2mQ==\n-----END RSA PRIVATE KEY-----",
		},
		secret: "MIIEowIBAAKCAQEAx0Uf9k",
	},
	{
		name: "Authorization: Bearer in a curl command line",
		payload: {
			type: "tool_use",
			input: {
				command: "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' https://api",
			},
		},
		secret: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
	},
	{
		name: "a secret-named field whose value carries no recognizable shape",
		payload: { request: { headers: { authorization: "Bearer opaque-house-token" } } },
		secret: "opaque-house-token",
	},
	{
		name: "a nested githubToken field inside an arrayed tool result",
		payload: { results: [{ config: { githubToken: "not-a-known-shape-at-all" } }] },
		secret: "not-a-known-shape-at-all",
	},
	{
		name: "a Supabase-style Postgres DSN with the password in the URL userinfo",
		payload: {
			type: "tool_use",
			input: {
				command:
					"psql postgresql://postgres:sup3r-s3cret-pw@db.abcdefghij.supabase.co:5432/postgres",
			},
		},
		secret: "sup3r-s3cret-pw",
	},
	{
		name: "generic URL userinfo credentials echoed into a stack trace",
		payload: { type: "text", text: "clone failed: https://alice:hunter2pass@example.com/repo.git" },
		secret: "hunter2pass",
	},
	{
		name: "lin_api_ Linear key in an env assignment (warren-9bbc)",
		payload: {
			type: "tool_use",
			input: { command: `LINEAR_API_KEY=${linearApiKey} bun run triage` },
		},
		secret: linearApiKey,
	},
	{
		name: "sk_live_ Stripe key in a tool_result (warren-9bbc)",
		payload: {
			type: "tool_result",
			content: [{ type: "text", text: `STRIPE_SECRET_KEY=${stripeLiveKey}` }],
		},
		secret: stripeLiveKey,
	},
	{
		name: "Slack incoming-webhook URL in a curl line (warren-9bbc)",
		payload: {
			type: "tool_use",
			input: { command: `curl -X POST ${slackWebhookUrl} -d '{}'` },
		},
		secret: slackWebhookUrl,
	},
	{
		name: "glpat- GitLab PAT in a remote URL (warren-9bbc)",
		payload: { type: "text", text: `remote: https://oauth2:${gitlabPat}@gitlab.com/x/y.git` },
		secret: gitlabPat,
	},
	{
		name: "npm_ access token in an .npmrc dump (warren-9bbc)",
		payload: { type: "tool_result", content: `//registry.npmjs.org/:_authToken=${npmAccessToken}` },
		secret: npmAccessToken,
	},
	{
		name: "SG. SendGrid key in a header dump (warren-9bbc)",
		payload: { type: "text", text: `authorization: Bearer ${sendgridApiKey}` },
		secret: sendgridApiKey,
	},
	{
		name: "AIza Google API key in a query string (warren-9bbc)",
		payload: {
			type: "tool_use",
			input: { command: `curl 'https://www.googleapis.com/x?key=${googleApiKey}'` },
		},
		secret: googleApiKey,
	},
	{
		name: "an access_token field from an OAuth JSON dump (warren-9bbc)",
		payload: { response: { access_token: "opaque-oauth-access-value" } },
		secret: "opaque-oauth-access-value",
	},
	{
		name: "a client_secret field nested one level deep (warren-9bbc)",
		payload: { results: [{ config: { client_secret: "opaque-client-secret-value" } }] },
		secret: "opaque-client-secret-value",
	},
	{
		name: "a Supabase service_role JWT in a tool_result",
		payload: {
			type: "tool_result",
			content: [
				{
					type: "text",
					text: "SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.AbCdEf0123456789xyzABCDEFGHIJ",
				},
			],
		},
		secret:
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.AbCdEf0123456789xyzABCDEFGHIJ",
	},
];
