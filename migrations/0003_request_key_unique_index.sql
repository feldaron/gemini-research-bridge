DROP INDEX IF EXISTS jobs_request_key_uq;

CREATE UNIQUE INDEX jobs_request_key_uq
  ON jobs(request_key);
