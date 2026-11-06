CREATE TABLE game_saves (
 owner_id text NOT NULL DEFAULT NULLIF(current_setting('hub.account_id',true),'') REFERENCES "user"(id) ON DELETE CASCADE,
 game_id text NOT NULL CHECK(game_id='shattered-pixel-dungeon'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 snapshot jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,game_id)
);
ALTER TABLE game_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_saves FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON game_saves
 USING(owner_id=NULLIF(current_setting('hub.account_id',true),''))
 WITH CHECK(owner_id=NULLIF(current_setting('hub.account_id',true),''));
