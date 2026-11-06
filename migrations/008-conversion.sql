CREATE TABLE conversion_uploads (
 owner_id text NOT NULL DEFAULT NULLIF(current_setting('hub.account_id',true),'') REFERENCES "user"(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 extension text NOT NULL CHECK(extension ~ '^[a-z0-9]{1,20}$'),
 bytes bigint NOT NULL CHECK(bytes>0),
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready')),
 sha256 text CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(owner_id,id), UNIQUE(id)
);
CREATE TABLE conversion_jobs (
 owner_id text NOT NULL DEFAULT NULLIF(current_setting('hub.account_id',true),'') REFERENCES "user"(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 upload_id uuid NOT NULL,
 target_format text NOT NULL CHECK(target_format ~ '^[a-z0-9][a-z0-9_-]{0,30}$'),
 requested_engine text NOT NULL CHECK(requested_engine IN ('auto','convertx','transmute','stirling','ncmdump')),
 engine text NOT NULL CHECK(engine IN ('convertx','transmute','stirling','ncmdump')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
 stage text NOT NULL DEFAULT '等待后台处理',
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 finished_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(owner_id,id), UNIQUE(id),
 FOREIGN KEY(owner_id,upload_id) REFERENCES conversion_uploads(owner_id,id)
);
CREATE TABLE conversion_outputs (
 owner_id text NOT NULL DEFAULT NULLIF(current_setting('hub.account_id',true),'') REFERENCES "user"(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 job_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 240),
 storage_name text NOT NULL CHECK(storage_name ~ '^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,100}$'),
 mime text NOT NULL CHECK(length(mime) BETWEEN 1 AND 150),
 bytes bigint NOT NULL CHECK(bytes>0),
 PRIMARY KEY(owner_id,id), UNIQUE(id),
 FOREIGN KEY(owner_id,job_id) REFERENCES conversion_jobs(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX conversion_jobs_pending ON conversion_jobs(owner_id,state,created_at);
CREATE INDEX conversion_jobs_expiry ON conversion_jobs(expires_at);
CREATE INDEX conversion_uploads_expiry ON conversion_uploads(expires_at);
CREATE INDEX conversion_outputs_job ON conversion_outputs(owner_id,job_id);

ALTER TABLE conversion_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON conversion_uploads
 USING(owner_id=NULLIF(current_setting('hub.account_id',true),''))
 WITH CHECK(owner_id=NULLIF(current_setting('hub.account_id',true),''));
ALTER TABLE conversion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON conversion_jobs
 USING(owner_id=NULLIF(current_setting('hub.account_id',true),''))
 WITH CHECK(owner_id=NULLIF(current_setting('hub.account_id',true),''));
ALTER TABLE conversion_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_outputs FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON conversion_outputs
 USING(owner_id=NULLIF(current_setting('hub.account_id',true),''))
 WITH CHECK(owner_id=NULLIF(current_setting('hub.account_id',true),''));
