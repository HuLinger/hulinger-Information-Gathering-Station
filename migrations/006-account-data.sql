-- Existing data belongs to the configured owner. Never infer ownership from a username.
DO $$
DECLARE table_name text; existing_owner text; has_data boolean; constraint_row record;
  business_tables text[] := ARRAY['entities','events','sources','source_records','sync_runs','snapshots','revisions','merge_operations','separate_records','export_jobs'];
BEGIN
  SELECT value->>'id' INTO existing_owner FROM app_settings WHERE key='owner';
  IF existing_owner IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "user" WHERE id=existing_owner) THEN
    RAISE EXCEPTION 'Configured owner does not exist; migration stopped';
  END IF;
  FOREACH table_name IN ARRAY business_tables LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)',table_name) INTO has_data;
    IF has_data AND existing_owner IS NULL THEN RAISE EXCEPTION 'Existing data has no configured owner; migration stopped'; END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN owner_id text REFERENCES "user"(id)',table_name);
    EXECUTE format('UPDATE %I SET owner_id=$1',table_name) USING existing_owner;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN owner_id SET NOT NULL, ALTER COLUMN owner_id SET DEFAULT NULLIF(current_setting(''hub.account_id'',true),'''')',table_name);
  END LOOP;
  -- Remove the old global relationships before replacing global keys with account keys.
  FOR constraint_row IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint
    WHERE contype='f' AND confrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(business_tables))
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.relation,constraint_row.conname); END LOOP;
  FOR constraint_row IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint
    WHERE contype IN ('p','u') AND conrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(business_tables))
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.relation,constraint_row.conname); END LOOP;
END $$;

ALTER TABLE entities ADD PRIMARY KEY(owner_id,id);
ALTER TABLE events ADD PRIMARY KEY(owner_id,id), ADD FOREIGN KEY(owner_id,entity_id) REFERENCES entities(owner_id,id);
ALTER TABLE sources ADD PRIMARY KEY(owner_id,id);
ALTER TABLE source_records ADD PRIMARY KEY(owner_id,id), ADD UNIQUE(owner_id,source_id,external_id),
 ADD FOREIGN KEY(owner_id,source_id) REFERENCES sources(owner_id,id),
 ADD FOREIGN KEY(owner_id,event_id) REFERENCES events(owner_id,id) ON DELETE SET NULL(event_id);
ALTER TABLE sync_runs ADD PRIMARY KEY(owner_id,id), ADD FOREIGN KEY(owner_id,source_id) REFERENCES sources(owner_id,id);
ALTER TABLE snapshots ADD PRIMARY KEY(owner_id,entity_id,observed_at), ADD FOREIGN KEY(owner_id,entity_id) REFERENCES entities(owner_id,id);
ALTER TABLE revisions ADD PRIMARY KEY(owner_id,id), ADD FOREIGN KEY(owner_id,event_id) REFERENCES events(owner_id,id) ON DELETE CASCADE;
ALTER TABLE merge_operations ADD PRIMARY KEY(owner_id,id), ADD FOREIGN KEY(owner_id,target_id) REFERENCES events(owner_id,id) ON DELETE CASCADE;
ALTER TABLE separate_records ADD PRIMARY KEY(owner_id,first_id,second_id),
 ADD FOREIGN KEY(owner_id,first_id) REFERENCES source_records(owner_id,id),
 ADD FOREIGN KEY(owner_id,second_id) REFERENCES source_records(owner_id,id);
ALTER TABLE export_jobs ADD PRIMARY KEY(owner_id,id);

CREATE TABLE account_settings (
 owner_id text NOT NULL DEFAULT NULLIF(current_setting('hub.account_id',true),'') REFERENCES "user"(id),
 key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(owner_id,key)
);
INSERT INTO account_settings(owner_id,key,value)
 SELECT (SELECT value->>'id' FROM app_settings WHERE key='owner'),key,value FROM app_settings WHERE key LIKE 'collector:%';
DELETE FROM app_settings WHERE key LIKE 'collector:%';

DO $$ DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['entities','events','sources','source_records','sync_runs','snapshots','revisions','merge_operations','separate_records','export_jobs','account_settings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY account_isolation ON %I USING (owner_id=NULLIF(current_setting(''hub.account_id'',true),'''')) WITH CHECK (owner_id=NULLIF(current_setting(''hub.account_id'',true),''''))',table_name);
 END LOOP;
END $$;

CREATE INDEX events_account_status_date ON events(owner_id,status,published_at DESC,discovered_at DESC);
CREATE INDEX events_account_entity ON events(owner_id,entity_id);
CREATE INDEX source_records_account_event ON source_records(owner_id,event_id);
CREATE INDEX export_jobs_account_status ON export_jobs(owner_id,status,created_at);
