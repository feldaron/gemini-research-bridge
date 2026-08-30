CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'antigravity',
  interaction_id TEXT NOT NULL UNIQUE,
  claim_token TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL,
  environment_id TEXT,
  error TEXT,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_polled_at DATETIME,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS agent_runs_active_idx
  ON agent_runs(status, updated_at);

CREATE INDEX IF NOT EXISTS agent_runs_job_idx
  ON agent_runs(job_id, started_at DESC);
