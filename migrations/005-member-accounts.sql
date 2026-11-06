-- Keep the configured owner ID, credentials and MFA intact while allowing managed members.
DROP INDEX IF EXISTS only_one_owner_account;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS username text;
CREATE UNIQUE INDEX IF NOT EXISTS user_username_normalized ON "user" (lower(username)) WHERE username IS NOT NULL;
UPDATE "user" SET username = 'admin'
WHERE id = (SELECT value->>'id' FROM app_settings WHERE key = 'owner') AND username IS NULL;

CREATE TABLE IF NOT EXISTS member_accounts (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  disabled boolean NOT NULL DEFAULT false,
  created_by text NOT NULL REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_events (
  id text PRIMARY KEY,
  user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  username text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  method text NOT NULL CHECK (method IN ('password', 'totp', 'backup-code')),
  ip_prefix text,
  user_agent text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_events_time ON login_events(occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS login_events_user_time ON login_events(user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS account_management_events (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('member_created', 'member_updated', 'member_disabled', 'member_enabled', 'password_reset', 'sessions_revoked')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_management_events_time ON account_management_events(occurred_at);
