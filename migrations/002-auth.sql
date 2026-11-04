-- Better Auth tables are created by its pinned programmatic migration before this file.
CREATE UNIQUE INDEX IF NOT EXISTS only_one_owner_account ON "user" ((true));

CREATE TABLE IF NOT EXISTS auth_session_assurance (
  session_id text PRIMARY KEY REFERENCES "session"(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_admin_audit (
  id text PRIMARY KEY,
  action text NOT NULL CHECK(action IN ('owner_created', 'owner_recovered')),
  user_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
