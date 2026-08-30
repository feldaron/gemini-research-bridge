interface Env {
  DB: D1Database;
  CLIENT_TOKEN: string;
  WORKER_TOKEN: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JobStatus = "queued" | "claimed" | "completed" | "failed";
type ReviewStatus = "pending" | "accepted" | "rejected";

type JobRow = {
  id: string;
  request_key: string | null;
  kind: string;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  available_at: string;
  claimed_by: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  claim_token: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type ProposalRow = {
  id: string;
  job_id: string;
  source_type: "worker" | "offline";
  source_id: string | null;
  result: string;
  review_status: ReviewStatus;
  reviewed_by: string | null;
  review_notes: string | null;
  created_at: string;
  reviewed_at: string | null;
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const OFFLINE_JOBS_FORMAT = "gemini-research-bridge.offline-jobs.v1";
const OFFLINE_PROPOSALS_FORMAT = "gemini-research-bridge.offline-proposals.v1";
const JOB_IMPORT_FORMAT = "gemini-research-bridge.jobs.v1";

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

function parseStoredJson(value: string | null): JsonValue | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function publicJob(row: JobRow) {
  return {
    id: row.id,
    request_key: row.request_key,
    kind: row.kind,
    payload: parseStoredJson(row.payload),
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    available_at: row.available_at,
    claimed_by: row.claimed_by,
    lease_expires_at: row.lease_expires_at,
    heartbeat_at: row.heartbeat_at,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

function workerJob(row: JobRow) {
  return {
    ...publicJob(row),
    claim_token: row.claim_token,
  };
}

function publicProposal(row: ProposalRow) {
  return {
    id: row.id,
    job_id: row.job_id,
    source_type: row.source_type,
    source_id: row.source_id,
    result: parseStoredJson(row.result),
    review_status: row.review_status,
    reviewed_by: row.reviewed_by,
    review_notes: row.review_notes,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i += 1) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice(7);
}

function authorized(request: Request, expected: string | undefined): boolean {
  const supplied = bearer(request);
  return Boolean(supplied && expected && constantTimeEqual(supplied, expected));
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("invalid_json");
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

async function addEvent(
  env: Env,
  jobId: string,
  eventType: string,
  actor: string | null,
  payload: JsonValue | null = null,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO job_events (id, job_id, event_type, actor, payload)
    VALUES (?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), jobId, eventType, actor, payload === null ? null : JSON.stringify(payload)).run();
}

async function insertJob(env: Env, input: {
  kind?: string;
  payload?: JsonValue;
  request_key?: string;
  priority?: number;
  max_attempts?: number;
}): Promise<{ row: JobRow; duplicate: boolean }> {
  const kind = cleanText(input.kind, 100);
  if (!kind) throw new Error("invalid_kind");
  if (!("payload" in input)) throw new Error("payload_required");

  const requestKey = cleanText(input.request_key, 200);
  const priority = clampInt(input.priority, 0, -100, 100);
  const maxAttempts = clampInt(input.max_attempts, 3, 1, 10);
  const id = crypto.randomUUID();
  const payload = JSON.stringify(input.payload);

  if (requestKey) {
    const inserted = await env.DB.prepare(`
      INSERT INTO jobs (id, request_key, kind, payload, priority, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_key) DO NOTHING
      RETURNING *
    `).bind(id, requestKey, kind, payload, priority, maxAttempts).first<JobRow>();

    if (inserted) {
      await addEvent(env, inserted.id, "submitted", "client", { request_key: requestKey });
      return { row: inserted, duplicate: false };
    }

    const existing = await env.DB.prepare("SELECT * FROM jobs WHERE request_key = ?")
      .bind(requestKey)
      .first<JobRow>();
    if (!existing) throw new Error("idempotency_lookup_failed");
    return { row: existing, duplicate: true };
  }

  const inserted = await env.DB.prepare(`
    INSERT INTO jobs (id, kind, payload, priority, max_attempts)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `).bind(id, kind, payload, priority, maxAttempts).first<JobRow>();
  if (!inserted) throw new Error("insert_failed");
  await addEvent(env, inserted.id, "submitted", "client");
  return { row: inserted, duplicate: false };
}

async function submitJob(request: Request, env: Env): Promise<Response> {
  const input = await body<{
    kind?: string;
    payload?: JsonValue;
    request_key?: string;
    priority?: number;
    max_attempts?: number;
  }>(request);
  try {
    const created = await insertJob(env, input);
    return json({ job: publicJob(created.row), duplicate: created.duplicate }, created.duplicate ? 200 : 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_job";
    if (message === "invalid_kind" || message === "payload_required") return json({ error: message }, 400);
    throw error;
  }
}

async function importJobs(request: Request, env: Env): Promise<Response> {
  const input = await body<{
    format?: string;
    jobs?: Array<{
      kind?: string;
      payload?: JsonValue;
      request_key?: string;
      priority?: number;
      max_attempts?: number;
    }>;
  }>(request);
  if (input.format !== JOB_IMPORT_FORMAT || !Array.isArray(input.jobs)) {
    return json({ error: "invalid_job_bundle", expected_format: JOB_IMPORT_FORMAT }, 400);
  }
  if (input.jobs.length > 500) return json({ error: "too_many_jobs", max: 500 }, 400);

  const imported: unknown[] = [];
  for (let index = 0; index < input.jobs.length; index += 1) {
    try {
      const created = await insertJob(env, input.jobs[index]);
      imported.push({ index, id: created.row.id, duplicate: created.duplicate, status: created.row.status });
    } catch (error) {
      imported.push({ index, error: error instanceof Error ? error.message : "invalid_job" });
    }
  }
  return json({ format: JOB_IMPORT_FORMAT, imported });
}

async function listJobs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const status = cleanText(url.searchParams.get("status"), 20);
  const kind = cleanText(url.searchParams.get("kind"), 100);
  const limit = clampInt(Number(url.searchParams.get("limit") ?? 100), 100, 1, 500);

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    if (!["queued", "claimed", "completed", "failed"].includes(status)) return json({ error: "invalid_status" }, 400);
    clauses.push("status = ?");
    binds.push(status);
  }
  if (kind) {
    clauses.push("kind = ?");
    binds.push(kind);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await env.DB.prepare(`
    SELECT * FROM jobs
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(...binds, limit).all<JobRow>();
  return json({ jobs: result.results.map(publicJob) });
}

async function exportJobs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const status = cleanText(url.searchParams.get("status"), 20) ?? "queued";
  const kind = cleanText(url.searchParams.get("kind"), 100);
  const limit = clampInt(Number(url.searchParams.get("limit") ?? 100), 100, 1, 500);
  if (!["queued", "claimed", "completed", "failed"].includes(status)) return json({ error: "invalid_status" }, 400);

  const query = kind
    ? "SELECT * FROM jobs WHERE status = ? AND kind = ? ORDER BY priority DESC, created_at ASC LIMIT ?"
    : "SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?";
  const statement = env.DB.prepare(query);
  const result = kind
    ? await statement.bind(status, kind, limit).all<JobRow>()
    : await statement.bind(status, limit).all<JobRow>();

  const bundle = {
    format: JOB_IMPORT_FORMAT,
    exported_at: new Date().toISOString(),
    jobs: result.results.map((row) => ({
      request_key: row.request_key,
      kind: row.kind,
      payload: parseStoredJson(row.payload),
      priority: row.priority,
      max_attempts: row.max_attempts,
    })),
  };
  return json(bundle, 200, { "content-disposition": 'attachment; filename="research-jobs.json"' });
}

async function claimOne(env: Env, workerId: string, leaseSeconds: number): Promise<JobRow | null> {
  const claimToken = crypto.randomUUID();
  const claimed = await env.DB.prepare(`
    UPDATE jobs
    SET status = 'claimed',
        claimed_by = ?,
        claim_token = ?,
        lease_expires_at = datetime('now', '+' || ? || ' seconds'),
        heartbeat_at = CURRENT_TIMESTAMP,
        attempts = attempts + 1,
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT id
      FROM jobs
      WHERE available_at <= CURRENT_TIMESTAMP
        AND attempts < max_attempts
        AND (
          status = 'queued'
          OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= CURRENT_TIMESTAMP)
        )
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    )
    RETURNING *
  `).bind(workerId, claimToken, leaseSeconds).first<JobRow>();

  if (claimed) await addEvent(env, claimed.id, "claimed", workerId, { lease_seconds: leaseSeconds });
  return claimed;
}

async function claimJob(request: Request, env: Env): Promise<Response> {
  const input = await body<{ worker_id?: string; lease_seconds?: number }>(request);
  const workerId = cleanText(input.worker_id, 200);
  if (!workerId) return json({ error: "invalid_worker_id" }, 400);
  const leaseSeconds = clampInt(input.lease_seconds, 300, 30, 1800);
  const claimed = await claimOne(env, workerId, leaseSeconds);
  return json({ job: claimed ? workerJob(claimed) : null });
}

async function heartbeatJob(request: Request, env: Env, id: string): Promise<Response> {
  const input = await body<{ worker_id?: string; claim_token?: string; lease_seconds?: number }>(request);
  const workerId = cleanText(input.worker_id, 200);
  const claimToken = cleanText(input.claim_token, 200);
  if (!workerId || !claimToken) return json({ error: "claim_credentials_required" }, 400);
  const leaseSeconds = clampInt(input.lease_seconds, 300, 30, 1800);

  const updated = await env.DB.prepare(`
    UPDATE jobs
    SET heartbeat_at = CURRENT_TIMESTAMP,
        lease_expires_at = datetime('now', '+' || ? || ' seconds'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'claimed'
      AND claimed_by = ?
      AND claim_token = ?
      AND lease_expires_at > CURRENT_TIMESTAMP
    RETURNING *
  `).bind(leaseSeconds, id, workerId, claimToken).first<JobRow>();

  if (!updated) return json({ error: "claim_not_owned_or_expired" }, 409);
  await addEvent(env, id, "heartbeat", workerId, { lease_seconds: leaseSeconds });
  return json({ job: workerJob(updated) });
}

async function createProposalFromClaim(
  env: Env,
  id: string,
  claimToken: string,
  result: JsonValue,
  sourceType: "worker" | "offline",
  sourceId: string | null,
  workerId?: string | null,
): Promise<{ job: JobRow; proposal: ProposalRow } | null> {
  const condition = workerId
    ? "id = ? AND status = 'claimed' AND claimed_by = ? AND claim_token = ? AND lease_expires_at > CURRENT_TIMESTAMP"
    : "id = ? AND status = 'claimed' AND claim_token = ? AND lease_expires_at > CURRENT_TIMESTAMP";
  const statement = env.DB.prepare(`
    UPDATE jobs
    SET status = 'completed',
        result = ?,
        error = NULL,
        claimed_by = NULL,
        claim_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE ${condition}
    RETURNING *
  `);
  const encoded = JSON.stringify(result);
  const updated = workerId
    ? await statement.bind(encoded, id, workerId, claimToken).first<JobRow>()
    : await statement.bind(encoded, id, claimToken).first<JobRow>();
  if (!updated) return null;

  const proposalId = crypto.randomUUID();
  const proposal = await env.DB.prepare(`
    INSERT INTO proposals (id, job_id, source_type, source_id, result)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `).bind(proposalId, id, sourceType, sourceId, encoded).first<ProposalRow>();
  if (!proposal) throw new Error("proposal_insert_failed");
  await addEvent(env, id, "proposal_submitted", sourceId, { proposal_id: proposalId, source_type: sourceType });
  return { job: updated, proposal };
}

async function proposeJob(request: Request, env: Env, id: string): Promise<Response> {
  const input = await body<{
    worker_id?: string;
    claim_token?: string;
    result?: JsonValue;
  }>(request);
  const workerId = cleanText(input.worker_id, 200);
  const claimToken = cleanText(input.claim_token, 200);
  if (!workerId || !claimToken) return json({ error: "claim_credentials_required" }, 400);
  if (!("result" in input)) return json({ error: "result_required" }, 400);

  const completed = await createProposalFromClaim(env, id, claimToken, input.result as JsonValue, "worker", workerId, workerId);
  if (!completed) return json({ error: "claim_not_owned_or_expired" }, 409);
  return json({ job: publicJob(completed.job), proposal: publicProposal(completed.proposal) });
}

async function failJob(request: Request, env: Env, id: string): Promise<Response> {
  const input = await body<{
    worker_id?: string;
    claim_token?: string;
    error?: string;
    retry?: boolean;
    retry_after_seconds?: number;
  }>(request);
  const workerId = cleanText(input.worker_id, 200);
  const claimToken = cleanText(input.claim_token, 200);
  if (!workerId || !claimToken) return json({ error: "claim_credentials_required" }, 400);
  const message = cleanText(input.error, 4000) ?? "worker_failed";
  const retry = input.retry !== false;
  const retryAfter = clampInt(input.retry_after_seconds, 0, 0, 86400);

  const updated = await env.DB.prepare(`
    UPDATE jobs
    SET status = CASE WHEN ? = 1 AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
        available_at = CASE WHEN ? = 1 AND attempts < max_attempts
          THEN datetime('now', '+' || ? || ' seconds') ELSE available_at END,
        error = ?,
        claimed_by = NULL,
        claim_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'claimed'
      AND claimed_by = ?
      AND claim_token = ?
      AND lease_expires_at > CURRENT_TIMESTAMP
    RETURNING *
  `).bind(retry ? 1 : 0, retry ? 1 : 0, retryAfter, message, id, workerId, claimToken).first<JobRow>();

  if (!updated) return json({ error: "claim_not_owned_or_expired" }, 409);
  await addEvent(env, id, updated.status === "queued" ? "retry_scheduled" : "failed", workerId, { error: message });
  return json({ job: publicJob(updated) });
}

async function getJob(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!row) return json({ error: "not_found" }, 404);
  const proposals = await env.DB.prepare("SELECT * FROM proposals WHERE job_id = ? ORDER BY created_at DESC")
    .bind(id)
    .all<ProposalRow>();
  return json({ job: publicJob(row), proposals: proposals.results.map(publicProposal) });
}

async function listProposals(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const reviewStatus = cleanText(url.searchParams.get("review_status"), 20) ?? "pending";
  const limit = clampInt(Number(url.searchParams.get("limit") ?? 100), 100, 1, 500);
  if (!["pending", "accepted", "rejected"].includes(reviewStatus)) return json({ error: "invalid_review_status" }, 400);

  const result = await env.DB.prepare(`
    SELECT p.*
    FROM proposals p
    WHERE p.review_status = ?
    ORDER BY p.created_at ASC
    LIMIT ?
  `).bind(reviewStatus, limit).all<ProposalRow>();

  const proposals: unknown[] = [];
  for (const proposal of result.results) {
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(proposal.job_id).first<JobRow>();
    proposals.push({ proposal: publicProposal(proposal), job: job ? publicJob(job) : null });
  }
  return json({ proposals });
}

async function reviewProposal(request: Request, env: Env, proposalId: string): Promise<Response> {
  const input = await body<{
    decision?: "accepted" | "rejected";
    reviewer?: string;
    notes?: string;
    requeue?: boolean;
  }>(request);
  if (input.decision !== "accepted" && input.decision !== "rejected") return json({ error: "invalid_decision" }, 400);
  const reviewer = cleanText(input.reviewer, 200) ?? "client";
  const notes = cleanText(input.notes, 4000);

  const proposal = await env.DB.prepare(`
    UPDATE proposals
    SET review_status = ?, reviewed_by = ?, review_notes = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND review_status = 'pending'
    RETURNING *
  `).bind(input.decision, reviewer, notes, proposalId).first<ProposalRow>();
  if (!proposal) return json({ error: "proposal_not_pending" }, 409);

  await addEvent(env, proposal.job_id, `proposal_${input.decision}`, reviewer, { proposal_id: proposalId, notes });

  let job: JobRow | null = null;
  if (input.decision === "rejected" && input.requeue === true) {
    job = await env.DB.prepare(`
      UPDATE jobs
      SET status = 'queued', available_at = CURRENT_TIMESTAMP, error = NULL,
          completed_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      RETURNING *
    `).bind(proposal.job_id).first<JobRow>();
    if (job) await addEvent(env, job.id, "requeued_after_rejection", reviewer, { proposal_id: proposalId });
  } else {
    job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(proposal.job_id).first<JobRow>();
  }

  return json({ proposal: publicProposal(proposal), job: job ? publicJob(job) : null });
}

async function offlineExport(request: Request, env: Env): Promise<Response> {
  const input = await body<{
    limit?: number;
    lease_seconds?: number;
    researcher?: string;
  }>(request);
  const limit = clampInt(input.limit, 20, 1, 200);
  const leaseSeconds = clampInt(input.lease_seconds, 86400, 300, 604800);
  const batchId = crypto.randomUUID();
  const researcher = cleanText(input.researcher, 120) ?? "manual-model";
  const workerId = `offline:${batchId}`;
  const jobs: unknown[] = [];

  for (let i = 0; i < limit; i += 1) {
    const claimed = await claimOne(env, workerId, leaseSeconds);
    if (!claimed) break;
    jobs.push({
      job_id: claimed.id,
      claim_token: claimed.claim_token,
      kind: claimed.kind,
      research_task: parseStoredJson(claimed.payload),
    });
  }

  const bundle = {
    format: OFFLINE_JOBS_FORMAT,
    batch_id: batchId,
    researcher,
    exported_at: new Date().toISOString(),
    lease_seconds: leaseSeconds,
    instructions: [
      "Research each job independently using the research_task instructions.",
      "Do not guess. If the evidence is insufficient, return resolution=unresolved.",
      "Preserve the supplied job_id and claim_token exactly.",
      `Return JSON using format ${OFFLINE_PROPOSALS_FORMAT}.`,
    ],
    proposal_shape: {
      job_id: "<copied job_id>",
      claim_token: "<copied claim_token>",
      result: {
        resolution: "proposed | unresolved",
        proposed_value: "<value or null>",
        evidence: [],
        reasoning: "<concise reasoning>",
        confidence: "high | medium | low",
        conflicts: [],
      },
    },
    jobs,
  };

  return json(bundle, 200, {
    "content-disposition": `attachment; filename="research-batch-${batchId}.json"`,
  });
}

async function offlineImport(request: Request, env: Env): Promise<Response> {
  const input = await body<{
    format?: string;
    batch_id?: string;
    researcher?: string;
    proposals?: Array<{
      job_id?: string;
      claim_token?: string;
      result?: JsonValue;
    }>;
  }>(request);
  if (input.format !== OFFLINE_PROPOSALS_FORMAT || !Array.isArray(input.proposals)) {
    return json({ error: "invalid_offline_bundle", expected_format: OFFLINE_PROPOSALS_FORMAT }, 400);
  }
  if (input.proposals.length > 200) return json({ error: "too_many_proposals", max: 200 }, 400);
  const researcher = cleanText(input.researcher, 120) ?? cleanText(input.batch_id, 120) ?? "manual-model";

  const imported: unknown[] = [];
  for (let index = 0; index < input.proposals.length; index += 1) {
    const item = input.proposals[index];
    const jobId = cleanText(item.job_id, 100);
    const claimToken = cleanText(item.claim_token, 200);
    if (!jobId || !claimToken || !("result" in item)) {
      imported.push({ index, error: "job_id_claim_token_and_result_required" });
      continue;
    }
    const completed = await createProposalFromClaim(
      env,
      jobId,
      claimToken,
      item.result as JsonValue,
      "offline",
      researcher,
      null,
    );
    if (!completed) {
      imported.push({ index, job_id: jobId, error: "claim_not_owned_or_expired" });
      continue;
    }
    imported.push({
      index,
      job_id: jobId,
      proposal_id: completed.proposal.id,
      review_status: completed.proposal.review_status,
    });
  }
  return json({ format: OFFLINE_PROPOSALS_FORMAT, imported });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "gemini-research-bridge", version: 1 });
      }

      if (url.pathname.startsWith("/v1/worker/")) {
        if (!authorized(request, env.WORKER_TOKEN)) return json({ error: "unauthorized" }, 401);
        if (request.method === "POST" && url.pathname === "/v1/worker/claim") return claimJob(request, env);
        const workerMatch = url.pathname.match(/^\/v1\/worker\/jobs\/([0-9a-f-]+)\/(heartbeat|propose|fail)$/i);
        if (!workerMatch) return json({ error: "not_found" }, 404);
        const [, id, action] = workerMatch;
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (action === "heartbeat") return heartbeatJob(request, env, id);
        if (action === "propose") return proposeJob(request, env, id);
        return failJob(request, env, id);
      }

      if (!url.pathname.startsWith("/v1/")) return json({ error: "not_found" }, 404);
      if (!authorized(request, env.CLIENT_TOKEN)) return json({ error: "unauthorized" }, 401);

      if (request.method === "POST" && url.pathname === "/v1/jobs") return submitJob(request, env);
      if (request.method === "GET" && url.pathname === "/v1/jobs") return listJobs(request, env);
      if (request.method === "POST" && url.pathname === "/v1/jobs/import") return importJobs(request, env);
      if (request.method === "GET" && url.pathname === "/v1/jobs/export") return exportJobs(request, env);
      if (request.method === "GET" && url.pathname === "/v1/proposals") return listProposals(request, env);
      if (request.method === "POST" && url.pathname === "/v1/offline/export") return offlineExport(request, env);
      if (request.method === "POST" && url.pathname === "/v1/offline/import") return offlineImport(request, env);

      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/i);
      if (jobMatch && request.method === "GET") return getJob(env, jobMatch[1]);

      const reviewMatch = url.pathname.match(/^\/v1\/proposals\/([0-9a-f-]+)\/review$/i);
      if (reviewMatch && request.method === "POST") return reviewProposal(request, env, reviewMatch[1]);

      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_json") return json({ error: "invalid_json" }, 400);
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  },
};
