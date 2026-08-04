-- warren-3206: run_inbox shipped in 0023 without RLS and was fixed manually
-- in Supabase (2026-07-28 inventory); this migration brings the migration
-- path in line so a fresh database is deny-all for PostgREST roles too.
ALTER TABLE "run_inbox" ENABLE ROW LEVEL SECURITY;
