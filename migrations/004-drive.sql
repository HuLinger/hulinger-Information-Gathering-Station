CREATE TABLE drive_files (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  size bigint NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','trash','deleting')),
  chunk_size integer NOT NULL CHECK (chunk_size > 0),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 0 AND 100000),
  last_modified bigint NOT NULL CHECK (last_modified >= 0),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX drive_files_owner_status ON drive_files(owner_id,status,created_at DESC);
CREATE INDEX drive_files_resume ON drive_files(owner_id,fingerprint,size) WHERE status='uploading';
CREATE TABLE drive_parts (
  file_id uuid NOT NULL REFERENCES drive_files(id) ON DELETE CASCADE,
  part_index integer NOT NULL CHECK (part_index >= 0),
  bytes integer NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(file_id,part_index)
);
