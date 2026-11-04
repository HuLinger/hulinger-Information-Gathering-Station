CREATE TABLE IF NOT EXISTS export_jobs (
 id text PRIMARY KEY,status text NOT NULL DEFAULT 'queued',created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',error text,payload jsonb
);
