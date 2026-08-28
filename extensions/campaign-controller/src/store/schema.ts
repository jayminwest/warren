/**
 * Explicit SQLite migrations for the campaign controller store.
 *
 * Every schema change is a new numbered entry in `MIGRATIONS`; nothing edits
 * an old entry. `migrate()` applies pending entries inside transactions and
 * records them in `schema_migrations`, so a crash mid-migration leaves the
 * database at a clean prior version.
 *
 * Boundary contract: no secret, token, credential, or password column may
 * ever appear in this schema (plan pl-91b6 risk 5, warren-2853 acceptance).
 * The schema-inspection test enforces it against the live database.
 */

export interface Migration {
	readonly id: number;
	readonly name: string;
	readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
	{
		id: 1,
		name: "001_init_campaign_state",
		sql: `
CREATE TABLE campaigns (
	id TEXT PRIMARY KEY,
	status TEXT NOT NULL,
	manifest_digest TEXT NOT NULL UNIQUE,
	manifest_json TEXT NOT NULL,
	policy_digest TEXT,
	budget_cap_usd_cents INTEGER,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL,
	approved_at_ms INTEGER
);

CREATE TABLE work_items (
	id TEXT PRIMARY KEY,
	campaign_id TEXT NOT NULL REFERENCES campaigns(id),
	position INTEGER NOT NULL,
	issue_ref TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL,
	UNIQUE(campaign_id, position)
);
CREATE INDEX idx_work_items_campaign ON work_items(campaign_id);

CREATE TABLE actions (
	id TEXT PRIMARY KEY,
	action_key TEXT NOT NULL UNIQUE,
	campaign_id TEXT NOT NULL REFERENCES campaigns(id),
	work_item_id TEXT REFERENCES work_items(id),
	action_type TEXT NOT NULL,
	request_digest TEXT NOT NULL,
	policy_digest TEXT,
	state TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	reserved_usd_cents INTEGER,
	started_at_ms INTEGER,
	settled_at_ms INTEGER,
	result_run_id TEXT,
	result_plan_run_id TEXT,
	result_branch TEXT,
	result_pr_number INTEGER,
	error_class TEXT,
	error_json TEXT,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_actions_campaign ON actions(campaign_id);
CREATE INDEX idx_actions_work_item ON actions(work_item_id);
CREATE INDEX idx_actions_state ON actions(state);

CREATE TABLE run_links (
	run_id TEXT PRIMARY KEY,
	plan_run_id TEXT,
	campaign_id TEXT NOT NULL REFERENCES campaigns(id),
	work_item_id TEXT REFERENCES work_items(id),
	action_id TEXT REFERENCES actions(id),
	branch TEXT,
	linked_at_ms INTEGER NOT NULL
);

CREATE TABLE pr_identities (
	id TEXT PRIMARY KEY,
	campaign_id TEXT NOT NULL REFERENCES campaigns(id),
	work_item_id TEXT NOT NULL REFERENCES work_items(id),
	upstream_owner TEXT NOT NULL,
	upstream_repo TEXT NOT NULL,
	fork_owner TEXT NOT NULL,
	fork_repo TEXT NOT NULL,
	head_branch TEXT NOT NULL,
	title TEXT,
	body_digest TEXT,
	pr_number INTEGER,
	pr_url TEXT,
	created_at_ms INTEGER NOT NULL,
	UNIQUE(campaign_id, work_item_id)
);

CREATE TABLE github_events (
	node_id TEXT PRIMARY KEY,
	campaign_id TEXT NOT NULL REFERENCES campaigns(id),
	event_kind TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	observed_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_github_events_campaign ON github_events(campaign_id);

CREATE TABLE attention_items (
	id TEXT PRIMARY KEY,
	campaign_id TEXT NOT NULL REFERENCES campaigns(id),
	work_item_id TEXT REFERENCES work_items(id),
	reason TEXT NOT NULL,
	detail_json TEXT,
	created_at_ms INTEGER NOT NULL,
	resolved_at_ms INTEGER
);
CREATE INDEX idx_attention_campaign ON attention_items(campaign_id);

CREATE TABLE budget_reservations (
	id TEXT PRIMARY KEY,
	campaign_id TEXT NOT NULL REFERENCES campaigns(id),
	action_id TEXT REFERENCES actions(id),
	amount_usd_cents INTEGER NOT NULL,
	state TEXT NOT NULL,
	settled_usd_cents INTEGER,
	created_at_ms INTEGER NOT NULL,
	settled_at_ms INTEGER
);
CREATE INDEX idx_budget_reservations_campaign ON budget_reservations(campaign_id);

CREATE TABLE leases (
	scope TEXT PRIMARY KEY,
	holder TEXT NOT NULL,
	acquired_at_ms INTEGER NOT NULL,
	expires_at_ms INTEGER NOT NULL
);
`,
	},
	{
		id: 2,
		name: "002_campaign_amendments",
		sql: `
CREATE TABLE campaign_amendments (
	id TEXT PRIMARY KEY,
	campaign_id TEXT NOT NULL REFERENCES campaigns(id),
	amendment_id TEXT NOT NULL,
	amendment_digest TEXT NOT NULL UNIQUE,
	previous_manifest_digest TEXT NOT NULL,
	new_manifest_digest TEXT NOT NULL,
	amendment_json TEXT NOT NULL,
	applied_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_campaign_amendments_campaign ON campaign_amendments(campaign_id);
`,
	},
];
