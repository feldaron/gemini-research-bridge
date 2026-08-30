CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  request_key TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','completed','failed')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_by TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_request_key_uq
  ON jobs(request_key)
  WHERE request_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_claim_queue_idx
  ON jobs(status, available_at, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS jobs_lease_expiry_idx
  ON jobs(status, lease_expires_at)
  WHERE status = 'claimed';
