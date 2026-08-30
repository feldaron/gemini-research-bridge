ALTER TABLE jobs ADD COLUMN claim_token TEXT;

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('worker','offline')),
  source_id TEXT,
  result TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','accepted','rejected')),
  reviewed_by TEXT,
  review_notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS proposals_review_queue_idx
  ON proposals(review_status, created_at ASC);

CREATE INDEX IF NOT EXISTS proposals_job_idx
  ON proposals(job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS job_events_job_idx
  ON job_events(job_id, created_at ASC);
