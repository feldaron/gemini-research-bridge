import bridge from "./index";

interface Env {
  DB: D1Database;
  CLIENT_TOKEN: string;
  WORKER_TOKEN: string;
  GEMINI_API_KEY?: string;
  ANTIGRAVITY_AGENT?: string;
  ANTIGRAVITY_CONCURRENCY?: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type RunRow = {
  id: string;
  job_id: string;
  provider: string;
  interaction_id: string;
  claim_token: string;
  worker_id: string;
  status: string;
  environment_id: string | null;
  error: string | null;
  started_at: string;
  last_polled_at: string | null;
  updated_at: string;
  completed_at: string | null;
};

type Interaction = {
  id?: string;
  status?: string;
  environment_id?: string;
  output_text?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: unknown;
};

const DEFAULT_AGENT = "antigravity-preview-05-2026";
const WORKER_ID = "cloud-antigravity";
const API_REVISION = "2026-05-20";
const LEASE_SECONDS = 1800;

function concurrency(env: Env): number {
  const parsed = Number(env.ANTIGRAVITY_CONCURRENCY ?? "1");
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(5, Math.trunc(parsed)));
}

async function internalBridge(env: Env, path: string, method = "GET", data?: unknown): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${env.WORKER_TOKEN}` });
  let body: string | undefined;
  if (data !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(data);
  }
  return bridge.fetch(new Request(`https://bridge.internal${path}`, { method, headers, body }), env);
}

function googleHeaders(env: Env): Headers {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  return new Headers({
    "content-type": "application/json",
    "x-goog-api-key": env.GEMINI_API_KEY,
    "Api-Revision": API_REVISION,
  });
}

async function startInteraction(env: Env, prompt: string): Promise<Interaction> {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: googleHeaders(env),
    body: JSON.stringify({
      agent: env.ANTIGRAVITY_AGENT || DEFAULT_AGENT,
      input: prompt,
      environment: "remote",
      background: true,
    }),
  });
  if (!response.ok) throw new Error(`Antigravity start ${response.status}: ${(await response.text()).slice(0, 1500)}`);
  return await response.json() as Interaction;
}

async function getInteraction(env: Env, interactionId: string): Promise<Interaction> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(interactionId)}`, {
    method: "GET",
    headers: googleHeaders(env),
  });
  if (!response.ok) throw new Error(`Antigravity poll ${response.status}: ${(await response.text()).slice(0, 1500)}`);
  return await response.json() as Interaction;
}

async function cancelInteraction(env: Env, interactionId: string): Promise<void> {
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(interactionId)}:cancel`, {
      method: "POST",
      headers: googleHeaders(env),
    });
  } catch {
    // Best effort only; a lost bridge claim should not block the scheduler.
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function interactionText(interaction: Interaction): string {
  if (typeof interaction.output_text === "string" && interaction.output_text.trim()) return interaction.output_text.trim();
  const steps = interaction.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    const text = step.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

function parseResearchResult(interaction: Interaction): JsonValue {
  const text = interactionText(interaction);
  if (!text) throw new Error("Antigravity completed without a text result");
  try {
    return JSON.parse(stripJsonFence(text)) as JsonValue;
  } catch {
    throw new Error(`Antigravity returned invalid JSON: ${text.slice(0, 1500)}`);
  }
}

async function markRun(env: Env, runId: string, status: string, error: string | null = null, environmentId: string | null = null): Promise<void> {
  await env.DB.prepare(`
    UPDATE agent_runs
    SET status = ?, error = ?, environment_id = COALESCE(?, environment_id),
        last_polled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
        completed_at = CASE WHEN ? IN ('completed','failed','cancelled','incomplete','requires_action','lost_claim') THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?
  `).bind(status, error, environmentId, status, runId).run();
}

async function failBridgeJob(env: Env, run: RunRow, message: string): Promise<void> {
  await internalBridge(env, `/v1/worker/jobs/${run.job_id}/fail`, "POST", {
    worker_id: run.worker_id,
    claim_token: run.claim_token,
    error: message.slice(0, 4000),
    retry: true,
    retry_after_seconds: 60,
  });
}

async function finishRun(env: Env, run: RunRow, interaction: Interaction): Promise<void> {
  const status = interaction.status ?? "failed";
  const environmentId = interaction.environment_id ?? null;

  if (status === "completed") {
    try {
      const result = parseResearchResult(interaction);
      const proposed = await internalBridge(env, `/v1/worker/jobs/${run.job_id}/propose`, "POST", {
        worker_id: run.worker_id,
        claim_token: run.claim_token,
        result,
      });
      if (!proposed.ok) throw new Error(`Bridge rejected proposal: ${(await proposed.text()).slice(0, 1500)}`);
      await markRun(env, run.id, "completed", null, environmentId);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "antigravity_result_failed";
      await failBridgeJob(env, run, message);
      await markRun(env, run.id, "failed", message, environmentId);
      return;
    }
  }

  const message = `Antigravity interaction ended with status ${status}${interaction.error ? `: ${JSON.stringify(interaction.error).slice(0, 1000)}` : ""}`;
  await failBridgeJob(env, run, message);
  await markRun(env, run.id, status, message, environmentId);
}

async function pollRun(env: Env, run: RunRow): Promise<void> {
  const heartbeat = await internalBridge(env, `/v1/worker/jobs/${run.job_id}/heartbeat`, "POST", {
    worker_id: run.worker_id,
    claim_token: run.claim_token,
    lease_seconds: LEASE_SECONDS,
  });
  if (!heartbeat.ok) {
    await cancelInteraction(env, run.interaction_id);
    await markRun(env, run.id, "lost_claim", `Bridge heartbeat failed: ${(await heartbeat.text()).slice(0, 1000)}`);
    return;
  }

  let interaction: Interaction;
  try {
    interaction = await getInteraction(env, run.interaction_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "antigravity_poll_failed";
    await env.DB.prepare(`
      UPDATE agent_runs SET error = ?, last_polled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(message.slice(0, 4000), run.id).run();
    return;
  }

  const status = interaction.status ?? "in_progress";
  if (status === "in_progress") {
    await markRun(env, run.id, "in_progress", null, interaction.environment_id ?? null);
    return;
  }
  await finishRun(env, run, interaction);
}

async function startRun(env: Env): Promise<boolean> {
  const claimResponse = await internalBridge(env, "/v1/worker/claim", "POST", {
    worker_id: WORKER_ID,
    lease_seconds: LEASE_SECONDS,
  });
  if (!claimResponse.ok) throw new Error(`Antigravity claim failed: ${(await claimResponse.text()).slice(0, 1500)}`);
  const claim = await claimResponse.json() as { job?: { id?: string; claim_token?: string; prompt?: string } | null };
  if (!claim.job?.id || !claim.job.claim_token || !claim.job.prompt) return false;

  try {
    const interaction = await startInteraction(env, claim.job.prompt);
    if (!interaction.id) throw new Error("Antigravity did not return an interaction id");

    const run: RunRow = {
      id: crypto.randomUUID(),
      job_id: claim.job.id,
      provider: "antigravity",
      interaction_id: interaction.id,
      claim_token: claim.job.claim_token,
      worker_id: WORKER_ID,
      status: interaction.status ?? "in_progress",
      environment_id: interaction.environment_id ?? null,
      error: null,
      started_at: new Date().toISOString(),
      last_polled_at: null,
      updated_at: new Date().toISOString(),
      completed_at: null,
    };

    await env.DB.prepare(`
      INSERT INTO agent_runs (id, job_id, provider, interaction_id, claim_token, worker_id, status, environment_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      run.id,
      run.job_id,
      run.provider,
      run.interaction_id,
      run.claim_token,
      run.worker_id,
      run.status,
      run.environment_id,
    ).run();

    if (run.status !== "in_progress") await finishRun(env, run, interaction);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "antigravity_start_failed";
    await internalBridge(env, `/v1/worker/jobs/${claim.job.id}/fail`, "POST", {
      worker_id: WORKER_ID,
      claim_token: claim.job.claim_token,
      error: message.slice(0, 4000),
      retry: true,
      retry_after_seconds: 60,
    });
    return false;
  }
}

export async function runAntigravityCycle(env: Env): Promise<void> {
  if (!env.GEMINI_API_KEY || !env.WORKER_TOKEN) return;

  const active = await env.DB.prepare(`
    SELECT * FROM agent_runs
    WHERE status = 'in_progress'
    ORDER BY started_at ASC
  `).all<RunRow>();

  for (const run of active.results) await pollRun(env, run);

  const activeCountRow = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'in_progress'
  `).first<{ count: number }>();
  let activeCount = Number(activeCountRow?.count ?? 0);
  const limit = concurrency(env);

  while (activeCount < limit) {
    const started = await startRun(env);
    if (!started) break;
    activeCount += 1;
  }
}
