CREATE TABLE IF NOT EXISTS entities (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('model','project','tool')), name text NOT NULL, url text NOT NULL,
 data jsonb NOT NULL DEFAULT '{}', followed boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS events (
 id text PRIMARY KEY, title text NOT NULL, summary text NOT NULL DEFAULT '', kind text NOT NULL CHECK(kind IN ('model','project','tool')),
 url text NOT NULL, published_at timestamptz, published_precision text NOT NULL DEFAULT 'unknown',
 discovered_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 entity_id text REFERENCES entities(id), source_name text NOT NULL, review_reason text,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','review','excluded','trash','merged')),
 deleted_at timestamptz, revision integer NOT NULL DEFAULT 1, manual boolean NOT NULL DEFAULT false,
 personal jsonb NOT NULL DEFAULT '{"favorite":false,"later":false,"read":false,"archived":false,"note":""}',
 overrides jsonb NOT NULL DEFAULT '{}', tags text[] NOT NULL DEFAULT '{}', originals jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_status_date ON events(status,published_at DESC,discovered_at DESC);
CREATE INDEX IF NOT EXISTS events_entity ON events(entity_id);
CREATE TABLE IF NOT EXISTS sources (
 id text PRIMARY KEY, name text NOT NULL, kind text NOT NULL, url text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, interval_minutes integer NOT NULL DEFAULT 60,
 config jsonb NOT NULL DEFAULT '{}', last_attempt timestamptz, last_success timestamptz, next_run timestamptz, error text, coverage text
);
CREATE TABLE IF NOT EXISTS source_records (
 id text PRIMARY KEY, source_id text REFERENCES sources(id), external_id text NOT NULL,
 event_id text REFERENCES events(id) ON DELETE SET NULL, data jsonb NOT NULL DEFAULT '{}',
 first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
 excluded boolean NOT NULL DEFAULT false, UNIQUE(source_id,external_id)
);
CREATE INDEX IF NOT EXISTS source_records_event ON source_records(event_id);
CREATE TABLE IF NOT EXISTS sync_runs (
 id text PRIMARY KEY, source_id text REFERENCES sources(id), status text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, added integer NOT NULL DEFAULT 0,
 updated integer NOT NULL DEFAULT 0, skipped integer NOT NULL DEFAULT 0, error text, coverage text
);
CREATE TABLE IF NOT EXISTS snapshots (entity_id text REFERENCES entities(id), observed_at timestamptz NOT NULL DEFAULT now(), stars integer NOT NULL, PRIMARY KEY(entity_id,observed_at));
CREATE TABLE IF NOT EXISTS revisions (id text PRIMARY KEY,event_id text REFERENCES events(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),action text NOT NULL,before_data jsonb,after_data jsonb);
CREATE TABLE IF NOT EXISTS merge_operations (id text PRIMARY KEY,target_id text REFERENCES events(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),snapshot jsonb NOT NULL,undone boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS separate_records (first_id text REFERENCES source_records(id),second_id text REFERENCES source_records(id),PRIMARY KEY(first_id,second_id));
CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY,value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS worker_heartbeats (id text PRIMARY KEY,seen_at timestamptz NOT NULL DEFAULT now());
