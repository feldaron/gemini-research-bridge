interface Env {
  DB: D1Database;
  BRIDGE_TOKEN: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JobRow = {
  id: string;
  request_key: string | null;
  kind: string;
  payload: string;
  status: "queued" | "claimed" | "completed" | "failed";
  priority: number;
  attempts: number;
  max_attempts: number;
  available_at: string;
  claimed_by: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
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

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i += 1) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix) || !env.BRIDGE_TOKEN) return false;
  return constantTimeEqual(header.slice(prefix.length), env.BRIDGE_TOKEN);
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

async function submitJob(request: Request, env: Env): Promise<Response> {
  const input = await body<{
    kind?: string;
    payload?: JsonValue;
    request_key?: string;
    priority?: number;
    max_attempts?: number;
  }>(request);

  const kind = typeof input.kind === "string" ? input.kind.trim() : "";
  if (!kind || kind.length > 100) return json({ error: "invalid_kind" }, 400);
  if (!("payload" in input)) return json({ error: "payload_required" }, 400);

  const requestKey = typeof input.request_key === "string" && input.request_key.trim()
    ? input.request_key.trim().slice(0, 200)
    : null;
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

    if (inserted) return json({ job: publicJob(inserted), duplicate: false }, 201);

    const existing = await env.DB.prepare("SELECT * FROM jobs WHERE request_key = ?")
      .bind(requestKey)
      .first<JobRow>();
    if (!existing) return json({ error: "idempotency_lookup_failed" }, 500);
    return json({ job: publicJob(existing), duplicate: true }, 200);
  }

  const inserted = await env.DB.prepare(`
    INSERT INTO jobs (id, kind, payload, priority, max_attempts)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `).bind(id, kind, payload, priority, maxAttempts).first<JobRow>();

  return json({ job: publicJob(inserted!) }, 201);
}

async function claimJob(request: Request, env: Env): Promise<Response> {
  const input = await body<{ worker_id?: string; lease_seconds?: number }>(request);
  const workerId = typeof input.worker_id === "string" ? input.worker_id.trim() : "";
  if (!workerId || workerId.length > 200) return json({ error: "invalid_worker_id" }, 400);
  const leaseSeconds = clampInt(input.lease_seconds, 300, 30, 1800);

  const claimed = await env.DB.prepare(`
    UPDATE jobs
    SET status = 'claimed',
        claimed_by = ?,
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
  `).bind(workerId, leaseSeconds).first<JobRow>();

  if (!claimed) return json({ job: null }, 200);
  return json({ job: publicJob(claimed) }, 200);
}

async function heartbeatJob(request: Request, env: Env, id: string): Promise<Response> {
  const input = await body<{ worker_id?: string; lease_seconds?: number }>(request);
  const workerId = typeof input.worker_id === "string" ? input.worker_id.trim() : "";
  if (!workerId) return json({ error: "invalid_worker_id" }, 400);
  const leaseSeconds = clampInt(input.lease_seconds, 300, 30, 1800);

  const updated = await env.DB.prepare(`
    UPDATE jobs
    SET heartbeat_at = CURRENT_TIMESTAMP,
        lease_expires_at = datetime('now', '+' || ? || ' seconds'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'claimed' AND claimed_by = ?
    RETURNING *
  `).bind(leaseSeconds, id, workerId).first<JobRow>();

  if (!updated) return json({ error: "claim_not_owned" }, 409);
  return json({ job: publicJob(updated) });
}

async function completeJob(request: Request, env: Env, id: string): Promise<Response> {
  const input = await body<{ worker_id?: string; result?: JsonValue }>(request);
  const workerId = typeof input.worker_id === "string" ? input.worker_id.trim() : "";
  if (!workerId) return json({ error: "invalid_worker_id" }, 400);
  if (!("result" in input)) return json({ error: "result_required" }, 400);

  const updated = await env.DB.prepare(`
    UPDATE jobs
    SET status = 'completed',
        result = ?,
        error = NULL,
        lease_expires_at = NULL,
        heartbeat_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'claimed' AND claimed_by = ?
    RETURNING *
  `).bind(JSON.stringify(input.result), id, workerId).first<JobRow>();

  if (!updated) return json({ error: "claim_not_owned" }, 409);
  return json({ job: publicJob(updated) });
}

async function failJob(request: Request, env: Env, id: string): Promise<Response> {
  const input = await body<{
    worker_id?: string;
    error?: string;
    retry?: boolean;
    retry_after_seconds?: number;
  }>(request);
  const workerId = typeof input.worker_id === "string" ? input.worker_id.trim() : "";
  if (!workerId) return json({ error: "invalid_worker_id" }, 400);
  const message = typeof input.error === "string" ? input.error.slice(0, 4000) : "worker_failed";
  const retry = input.retry !== false;
  const retryAfter = clampInt(input.retry_after_seconds, 0, 0, 86400);

  const updated = await env.DB.prepare(`
    UPDATE jobs
    SET status = CASE WHEN ? = 1 AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
        available_at = CASE WHEN ? = 1 AND attempts < max_attempts
          THEN datetime('now', '+' || ? || ' seconds') ELSE available_at END,
        error = ?,
        claimed_by = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'claimed' AND claimed_by = ?
    RETURNING *
  `).bind(retry ? 1 : 0, retry ? 1 : 0, retryAfter, message, id, workerId).first<JobRow>();

  if (!updated) return json({ error: "claim_not_owned" }, 409);
  return json({ job: publicJob(updated) });
}

async function getJob(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!row) return json({ error: "not_found" }, 404);
  return json({ job: publicJob(row) });
}

async function getResult(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT status, result, error FROM jobs WHERE id = ?")
    .bind(id)
    .first<{ status: string; result: string | null; error: string | null }>();
  if (!row) return json({ error: "not_found" }, 404);
  if (row.status !== "completed") return json({ error: "not_completed", status: row.status, detail: row.error }, 409);
  return json({ result: parseStoredJson(row.result) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "gemini-research-bridge" });
      }

      if (!url.pathname.startsWith("/v1/")) return json({ error: "not_found" }, 404);
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

      if (request.method === "POST" && url.pathname === "/v1/jobs") return submitJob(request, env);
      if (request.method === "POST" && url.pathname === "/v1/jobs/claim") return claimJob(request, env);

      const match = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)(?:\/(heartbeat|complete|fail|result))?$/i);
      if (!match) return json({ error: "not_found" }, 404);

      const [, id, action] = match;
      if (request.method === "GET" && !action) return getJob(env, id);
      if (request.method === "GET" && action === "result") return getResult(env, id);
      if (request.method === "POST" && action === "heartbeat") return heartbeatJob(request, env, id);
      if (request.method === "POST" && action === "complete") return completeJob(request, env, id);
      if (request.method === "POST" && action === "fail") return failJob(request, env, id);

      return json({ error: "method_not_allowed" }, 405);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_json") return json({ error: "invalid_json" }, 400);
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  },
};
