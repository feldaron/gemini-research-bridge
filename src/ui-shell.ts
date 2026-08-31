interface Env {
  DB: D1Database;
  CLIENT_TOKEN: string;
  WORKER_TOKEN: string;
  GEMINI_API_KEY?: string;
  ANTIGRAVITY_AGENT?: string;
}

type UiAuth = {
  salt: string;
  hash: string;
  iterations: number;
};

type JobViewRow = {
  job_id: string;
  request_key: string | null;
  job_status: string;
  job_payload: string;
  attempts: number;
  max_attempts: number;
  job_error: string | null;
  job_created_at: string;
  job_updated_at: string;
  job_completed_at: string | null;
  interaction_id: string | null;
  run_status: string | null;
  environment_id: string | null;
  run_error: string | null;
  run_started_at: string | null;
  last_polled_at: string | null;
  run_completed_at: string | null;
  proposal_id: string | null;
  proposal_result: string | null;
  review_status: string | null;
  reviewed_by: string | null;
  review_notes: string | null;
  proposal_created_at: string | null;
  reviewed_at: string | null;
  proposal_count: number;
  rejected_count: number;
};

type JobMetrics = {
  total_jobs: number;
  active_jobs: number;
  awaiting_review: number;
  accepted_jobs: number;
  rejected_jobs: number;
};

type ResearchResult = {
  resolution?: unknown;
  proposed_value?: unknown;
  evidence?: unknown;
  reasoning?: unknown;
  confidence?: unknown;
  conflicts?: unknown;
  research_notes?: unknown;
};

const textEncoder = new TextEncoder();
const SESSION_COOKIE = "grb_ui";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_AGENT = "antigravity-preview-05-2026";

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title: string, body: string): Response {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Gemini Research Bridge</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}.shell{max-width:1180px;margin:0 auto;padding:28px 18px 64px}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px}.top h1{font-size:22px;margin:0}.top p{margin:5px 0 0;color:#64748b;font-size:13px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 2px 10px rgba(15,23,42,.035)}.login{max-width:470px;margin:10vh auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.metric strong{display:block;font-size:22px}.metric span,.muted{color:#64748b}.small{font-size:12px}.pill{display:inline-block;padding:4px 9px;border-radius:999px;background:#eef2ff;font-size:12px;font-weight:650}.ok{background:#ecfdf5;color:#166534}.bad{background:#fef2f2;color:#991b1b}.warn{background:#fffbeb;color:#92400e}.info{background:#eff6ff;color:#1d4ed8}.neutral{background:#f1f5f9;color:#475569}.row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}label{display:block;font-size:13px;font-weight:650;margin:12px 0 5px}input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;background:#fff;font:inherit}button,.button{appearance:none;border:0;border-radius:8px;background:#172033;color:#fff;padding:9px 13px;font-weight:600;cursor:pointer;text-decoration:none;font-size:13px}.secondary{background:#475569}.danger{background:#991b1b}.ghost{background:#e2e8f0;color:#172033}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}.flash{background:#ecfdf5;border:1px solid #a7f3d0;padding:10px;border-radius:8px;margin-bottom:14px}.error{background:#fef2f2;border-color:#fecaca}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.task{white-space:pre-wrap}.status-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#22c55e}.status-dot.off{background:#94a3b8}.jobs{display:grid;gap:10px}.job{border:1px solid #dbe3ef;border-radius:12px;background:#fff;overflow:hidden}.job>summary{list-style:none;cursor:pointer;padding:15px 16px}.job>summary::-webkit-details-marker{display:none}.job>summary:before{content:"›";display:inline-block;margin-right:9px;font-size:20px;line-height:1;transition:transform .15s;color:#64748b}.job[open]>summary:before{transform:rotate(90deg)}.job-summary{display:inline-grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;vertical-align:top;width:calc(100% - 28px)}.job-title{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.job-meta{display:flex;gap:7px;align-items:center;justify-content:flex-end;flex-wrap:wrap}.job-body{border-top:1px solid #e2e8f0;background:#fbfcfe;padding:16px}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.section{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px;min-width:0}.section h3{font-size:14px;margin:0 0 10px}.section p{margin:7px 0;line-height:1.5}.section.wide{grid-column:1/-1}.facts{display:grid;grid-template-columns:minmax(120px,.35fr) minmax(0,1fr);gap:6px 12px;margin:0}.facts dt{color:#64748b;font-size:12px}.facts dd{margin:0;min-width:0}.human-list{display:grid;grid-template-columns:minmax(120px,.35fr) minmax(0,1fr);gap:7px 12px;margin:4px 0}.human-list dt{font-size:12px;color:#64748b}.human-list dd{margin:0;min-width:0}.human-list ul,.section ul{margin:6px 0;padding-left:20px}.evidence{border-left:3px solid #cbd5e1;padding-left:11px;margin:12px 0}.evidence:first-child{margin-top:0}.evidence-title{font-weight:700}.pre{white-space:pre-wrap;overflow-wrap:anywhere}.review-banner{border-radius:9px;padding:11px 12px;margin-bottom:10px;font-weight:700}.review-banner.ok{border:1px solid #bbf7d0}.review-banner.bad{border:1px solid #fecaca}.review-banner.warn{border:1px solid #fde68a}.review-banner.info{border:1px solid #bfdbfe}.review-banner.neutral{border:1px solid #e2e8f0}.technical{margin-top:10px}.technical summary{cursor:pointer;color:#475569;font-size:12px;font-weight:650}.technical .facts{margin-top:10px}.empty{padding:22px;text-align:center;color:#64748b}.toolbar{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.toolbar h2{margin:0}.subtle-link{color:#334155;text-decoration:none}.subtle-link:hover{text-decoration:underline}@media(max-width:760px){.top{align-items:flex-start;flex-direction:column}.job-summary{grid-template-columns:1fr}.job-meta{justify-content:flex-start}.detail-grid{grid-template-columns:1fr}.section.wide{grid-column:auto}.facts,.human-list{grid-template-columns:1fr;gap:2px}.facts dd,.human-list dd{margin-bottom:7px}}
</style></head><body><main class="shell">${body}</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}

function constantTimeEqual(a: string, b: string): boolean {
  const aa = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i += 1) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 24): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToHex(data);
}

async function derivePasswordHash(password: string, saltHex: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g)?.map((part) => parseInt(part, 16)) ?? []);
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

async function getUiAuth(env: Env): Promise<UiAuth | null> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'ui_auth'").first<{ value: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as UiAuth;
    return parsed.salt && parsed.hash && parsed.iterations ? parsed : null;
  } catch {
    return null;
  }
}

async function saveUiAuth(env: Env, password: string): Promise<UiAuth> {
  const iterations = 100000;
  const salt = randomHex(24);
  const hash = await derivePasswordHash(password, salt, iterations);
  const auth = { salt, hash, iterations };
  await env.DB.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('ui_auth', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(JSON.stringify(auth)).run();
  return auth;
}

async function sessionSignature(auth: UiAuth, expiry: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(auth.hash), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(expiry));
  return bytesToHex(new Uint8Array(signature));
}

async function sessionCookie(auth: UiAuth): Promise<string> {
  const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const signature = await sessionSignature(auth, expiry);
  return `${SESSION_COOKIE}=${expiry}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function hasUiSession(request: Request, auth: UiAuth): Promise<boolean> {
  const value = cookieValue(request, SESSION_COOKIE);
  if (!value) return false;
  const [expiry, signature] = value.split(".");
  if (!expiry || !signature || Number(expiry) < Math.floor(Date.now() / 1000)) return false;
  return constantTimeEqual(signature, await sessionSignature(auth, expiry));
}

function setupPage(error = ""): Response {
  return page("Set up dashboard", `<div class="login card">
<h1>Gemini Research Bridge</h1><p class="muted">Choose the password you want to use for this private dashboard.</p>
${error ? `<div class="flash error">${esc(error)}</div>` : ""}
<form method="post" action="/ui/setup">
<label>New UI password</label><input type="password" name="password" minlength="10" required autocomplete="new-password">
<label>Confirm password</label><input type="password" name="confirm" minlength="10" required autocomplete="new-password">
<div class="actions"><button type="submit">Create password</button></div>
</form><p class="small muted">The password is salted and hashed server-side. It is never embedded in browser JavaScript.</p></div>`);
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function labelFor(key: string): string {
  return key.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderHumanValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined || value === "") return '<span class="muted">Not supplied</span>';
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return esc(value);
  if (typeof value === "string") {
    const href = safeHref(value);
    return href ? `<a class="subtle-link" href="${esc(href)}" target="_blank" rel="noreferrer">${esc(value)}</a>` : `<span class="pre">${esc(value)}</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="muted">None</span>';
    return `<ul>${value.map((item) => `<li>${renderHumanValue(item, depth + 1)}</li>`).join("")}</ul>`;
  }
  const record = asRecord(value);
  if (!record) return esc(String(value));
  const entries = Object.entries(record);
  if (entries.length === 0) return '<span class="muted">None</span>';
  if (depth >= 3) return esc(entries.map(([key, item]) => `${labelFor(key)}: ${String(item ?? "")}`).join("; "));
  return `<dl class="human-list">${entries.map(([key, item]) => `<dt>${esc(labelFor(key))}</dt><dd>${renderHumanValue(item, depth + 1)}</dd>`).join("")}</dl>`;
}

function payloadInfo(payload: string): { task: string; context: unknown; instructions: unknown } {
  const parsed = asRecord(parseJson(payload));
  if (!parsed) return { task: payload, context: null, instructions: null };
  const task = typeof parsed.task === "string" ? parsed.task : "Research task";
  const context = parsed.context ?? null;
  const instructions = parsed.extra_instructions ?? parsed.instructions ?? null;
  return { task, context, instructions };
}

function statusDisplay(status: string): { label: string; cls: string } {
  switch (status) {
    case "queued": return { label: "Waiting to start", cls: "neutral" };
    case "claimed": return { label: "Researching", cls: "info" };
    case "completed": return { label: "Research complete", cls: "ok" };
    case "failed": return { label: "Failed", cls: "bad" };
    case "in_progress": return { label: "Running", cls: "info" };
    case "cancelled": return { label: "Cancelled", cls: "bad" };
    default: return { label: labelFor(status), cls: "neutral" };
  }
}

function reviewDisplay(row: JobViewRow): { label: string; cls: string; explanation: string } {
  if (row.review_status === "accepted") return { label: "Accepted", cls: "ok", explanation: "The research response was reviewed and accepted." };
  if (row.review_status === "rejected" && (row.job_status === "queued" || row.job_status === "claimed")) {
    return { label: "Research again", cls: "warn", explanation: "The previous response was rejected and the job was sent back for more research." };
  }
  if (row.review_status === "rejected") return { label: "Rejected", cls: "bad", explanation: "The research response was reviewed and rejected." };
  if (row.review_status === "pending") return { label: "Awaiting review", cls: "warn", explanation: "Research is complete and waiting for a review decision." };
  if (row.job_status === "failed") return { label: "No decision", cls: "bad", explanation: "The job failed before a reviewable response was produced." };
  return { label: "No decision yet", cls: "neutral", explanation: "There is not yet a reviewable response." };
}

function renderEvidence(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No evidence was returned.</p>';
  return value.map((item) => {
    const evidence = asRecord(item);
    if (!evidence) return `<div class="evidence">${renderHumanValue(item)}</div>`;
    const title = typeof evidence.source_title === "string" ? evidence.source_title : "Source";
    const href = safeHref(evidence.url);
    const heading = href ? `<a class="subtle-link evidence-title" href="${esc(href)}" target="_blank" rel="noreferrer">${esc(title)}</a>` : `<span class="evidence-title">${esc(title)}</span>`;
    const type = typeof evidence.source_type === "string" ? labelFor(evidence.source_type) : "";
    return `<div class="evidence">${heading}${type ? ` <span class="pill neutral">${esc(type)}</span>` : ""}
${evidence.evidence_text ? `<p>${renderHumanValue(evidence.evidence_text)}</p>` : ""}
${evidence.applies_to ? `<p class="small"><strong>Applies to:</strong> ${renderHumanValue(evidence.applies_to)}</p>` : ""}
${evidence.applicability ? `<p class="small muted"><strong>Why it applies:</strong> ${renderHumanValue(evidence.applicability)}</p>` : ""}</div>`;
  }).join("");
}

function renderResearchResponse(resultText: string | null): string {
  if (!resultText) return '<p class="muted">No research response has been returned yet.</p>';
  const parsed = asRecord(parseJson(resultText)) as ResearchResult | null;
  if (!parsed) return `<p>${renderHumanValue(parseJson(resultText))}</p>`;
  const confidence = typeof parsed.confidence === "string" ? labelFor(parsed.confidence) : "Not stated";
  const resolution = typeof parsed.resolution === "string" ? labelFor(parsed.resolution) : "Not stated";
  return `<div class="row"><span class="pill info">${esc(resolution)}</span><span class="pill neutral">Confidence: ${esc(confidence)}</span></div>
<h3 style="margin-top:16px">Proposed answer</h3>${renderHumanValue(parsed.proposed_value)}
<h3 style="margin-top:16px">Reasoning</h3>${parsed.reasoning ? `<p>${renderHumanValue(parsed.reasoning)}</p>` : '<p class="muted">No reasoning supplied.</p>'}
<h3 style="margin-top:16px">Evidence</h3>${renderEvidence(parsed.evidence)}
<h3 style="margin-top:16px">Conflicts</h3>${renderHumanValue(parsed.conflicts)}
${parsed.research_notes ? `<h3 style="margin-top:16px">Research notes</h3>${renderHumanValue(parsed.research_notes)}` : ""}`;
}

function renderJob(row: JobViewRow): string {
  const request = payloadInfo(row.job_payload);
  const jobState = statusDisplay(row.job_status);
  const review = reviewDisplay(row);
  const runState = row.run_status ? statusDisplay(row.run_status) : null;
  const issueNumber = row.request_key?.startsWith("github-issue:") ? row.request_key.split(":").pop() : null;
  return `<details class="job">
<summary><span class="job-summary"><span><span class="job-title">${esc(request.task)}</span><br><span class="small muted">Created ${esc(row.job_created_at)} · attempt ${esc(row.attempts)}/${esc(row.max_attempts)}</span></span><span class="job-meta"><span class="pill ${jobState.cls}">${esc(jobState.label)}</span><span class="pill ${review.cls}">${esc(review.label)}</span></span></span></summary>
<div class="job-body"><div class="detail-grid">
<section class="section"><h3>Request</h3><p class="task"><strong>${esc(request.task)}</strong></p><p class="small muted"><strong>Context</strong></p>${renderHumanValue(request.context)}<p class="small muted"><strong>Extra instructions</strong></p>${renderHumanValue(request.instructions)}${issueNumber ? `<p class="small">Submitted from GitHub issue #${esc(issueNumber)}.</p>` : ""}</section>
<section class="section"><h3>Antigravity run</h3>${runState ? `<div class="row"><span class="pill ${runState.cls}">${esc(runState.label)}</span></div>` : '<p class="muted">The job has not started an Antigravity interaction yet.</p>'}<dl class="facts"><dt>Started</dt><dd>${esc(row.run_started_at ?? "Not started")}</dd><dt>Last checked</dt><dd>${esc(row.last_polled_at ?? "—")}</dd><dt>Finished</dt><dd>${esc(row.run_completed_at ?? "—")}</dd><dt>Attempts</dt><dd>${esc(row.attempts)} of ${esc(row.max_attempts)}</dd></dl>${row.run_error || row.job_error ? `<p class="bad" style="padding:8px;border-radius:7px"><strong>Error:</strong> ${esc(row.run_error ?? row.job_error)}</p>` : ""}</section>
<section class="section wide"><h3>Research response</h3>${renderResearchResponse(row.proposal_result)}</section>
<section class="section wide"><h3>Review decision</h3><div class="review-banner ${review.cls}">${esc(review.label)} — ${esc(review.explanation)}</div><dl class="facts"><dt>Reviewed by</dt><dd>${esc(row.reviewed_by ?? "Not reviewed yet")}</dd><dt>Reviewed at</dt><dd>${esc(row.reviewed_at ?? "—")}</dd><dt>Reviewer notes</dt><dd>${row.review_notes ? renderHumanValue(row.review_notes) : '<span class="muted">None</span>'}</dd><dt>Proposal history</dt><dd>${esc(row.proposal_count)} proposal${row.proposal_count === 1 ? "" : "s"}${row.rejected_count > 0 ? ` · ${esc(row.rejected_count)} rejected` : ""}</dd></dl></section>
</div><details class="technical"><summary>Technical details</summary><dl class="facts"><dt>Job ID</dt><dd class="mono">${esc(row.job_id)}</dd><dt>Request key</dt><dd class="mono">${esc(row.request_key ?? "—")}</dd><dt>Interaction ID</dt><dd class="mono">${esc(row.interaction_id ?? "—")}</dd><dt>Environment ID</dt><dd class="mono">${esc(row.environment_id ?? "—")}</dd><dt>Proposal ID</dt><dd class="mono">${esc(row.proposal_id ?? "—")}</dd><dt>Job updated</dt><dd>${esc(row.job_updated_at)}</dd><dt>Job completed</dt><dd>${esc(row.job_completed_at ?? "—")}</dd><dt>Proposal created</dt><dd>${esc(row.proposal_created_at ?? "—")}</dd></dl></details></div></details>`;
}

async function keyFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return bytesToHex(new Uint8Array(digest)).slice(0, 12);
}

export async function loadStoredGeminiKey(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'gemini_api_key'").first<{ value: string }>();
  return row?.value?.trim() || null;
}

async function verifyGeminiKey(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: {
        "x-goog-api-key": key,
        "x-goog-api-client": "laptopvalue-gemini-research-bridge/1.0",
      },
    });
    if (response.ok) return { ok: true, message: "Google accepted the credential." };
    const detail = (await response.text()).slice(0, 600);
    return { ok: false, message: `Google rejected the credential (${response.status}). ${detail}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not contact Google." };
  }
}

async function agentPage(request: Request, env: Env, message = "", isError = false): Promise<Response> {
  const auth = await getUiAuth(env);
  if (!auth || !(await hasUiSession(request, auth))) return redirect("/");
  const storedKey = await loadStoredGeminiKey(env);
  const activeKey = storedKey || env.GEMINI_API_KEY || "";
  const source = storedKey ? "Dashboard credential" : env.GEMINI_API_KEY ? "Cloudflare Worker secret" : "Not connected";
  const fingerprint = activeKey ? await keyFingerprint(activeKey) : "—";

  const jobs = await env.DB.prepare(`
    SELECT
      j.id AS job_id,
      j.request_key,
      j.status AS job_status,
      j.payload AS job_payload,
      j.attempts,
      j.max_attempts,
      j.error AS job_error,
      j.created_at AS job_created_at,
      j.updated_at AS job_updated_at,
      j.completed_at AS job_completed_at,
      ar.interaction_id,
      ar.status AS run_status,
      ar.environment_id,
      ar.error AS run_error,
      ar.started_at AS run_started_at,
      ar.last_polled_at,
      ar.completed_at AS run_completed_at,
      p.id AS proposal_id,
      p.result AS proposal_result,
      p.review_status,
      p.reviewed_by,
      p.review_notes,
      p.created_at AS proposal_created_at,
      p.reviewed_at,
      (SELECT COUNT(*) FROM proposals pc WHERE pc.job_id = j.id) AS proposal_count,
      (SELECT COUNT(*) FROM proposals pr WHERE pr.job_id = j.id AND pr.review_status = 'rejected') AS rejected_count
    FROM jobs j
    LEFT JOIN agent_runs ar ON ar.id = (
      SELECT ar2.id FROM agent_runs ar2 WHERE ar2.job_id = j.id ORDER BY ar2.started_at DESC LIMIT 1
    )
    LEFT JOIN proposals p ON p.id = (
      SELECT p2.id FROM proposals p2 WHERE p2.job_id = j.id ORDER BY p2.created_at DESC LIMIT 1
    )
    WHERE j.kind = 'research'
    ORDER BY j.created_at DESC
    LIMIT 100
  `).all<JobViewRow>();

  const metrics = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total_jobs,
      SUM(CASE WHEN j.status IN ('queued','claimed') THEN 1 ELSE 0 END) AS active_jobs,
      SUM(CASE WHEN (SELECT review_status FROM proposals p WHERE p.job_id = j.id ORDER BY p.created_at DESC LIMIT 1) = 'pending' THEN 1 ELSE 0 END) AS awaiting_review,
      SUM(CASE WHEN (SELECT review_status FROM proposals p WHERE p.job_id = j.id ORDER BY p.created_at DESC LIMIT 1) = 'accepted' THEN 1 ELSE 0 END) AS accepted_jobs,
      SUM(CASE WHEN (SELECT review_status FROM proposals p WHERE p.job_id = j.id ORDER BY p.created_at DESC LIMIT 1) = 'rejected' AND j.status NOT IN ('queued','claimed') THEN 1 ELSE 0 END) AS rejected_jobs
    FROM jobs j WHERE j.kind = 'research'
  `).first<JobMetrics>();

  const m = metrics ?? { total_jobs: 0, active_jobs: 0, awaiting_review: 0, accepted_jobs: 0, rejected_jobs: 0 };
  const jobHtml = jobs.results.map(renderJob).join("") || '<div class="empty">No research jobs yet.</div>';
  const autoRefresh = `<script>setTimeout(()=>{if(!document.querySelector('.job[open]'))location.reload()},15000)</script>`;

  return page("Antigravity jobs", `<div class="top"><div><h1>Antigravity jobs</h1><p>Human-readable research requests, responses and review decisions</p></div><div class="actions"><a class="button ghost" href="/">Dashboard</a><a class="button secondary" href="/ui/agent">Refresh</a></div></div>
${message ? `<div class="flash ${isError ? "error" : ""}">${esc(message)}</div>` : ""}
<div class="grid">
<div class="card metric"><strong><i class="status-dot ${activeKey ? "" : "off"}"></i> ${activeKey ? "Connected" : "Disconnected"}</strong><span>Google authentication</span></div>
<div class="card metric"><strong>${esc(m.total_jobs)}</strong><span>Total research jobs</span></div>
<div class="card metric"><strong>${esc(m.active_jobs)}</strong><span>Waiting or researching</span></div>
<div class="card metric"><strong>${esc(m.awaiting_review)}</strong><span>Awaiting review</span></div>
<div class="card metric"><strong>${esc(m.accepted_jobs)}</strong><span>Accepted</span></div>
<div class="card metric"><strong>${esc(m.rejected_jobs)}</strong><span>Rejected</span></div>
</div>
<div class="card"><details><summary style="cursor:pointer;font-weight:700">Google authentication & agent settings</summary><div style="margin-top:14px"><div class="row"><span class="pill ${activeKey ? "ok" : "bad"}">${esc(source)}</span><span class="small muted">fingerprint ${esc(fingerprint)}</span><span class="pill neutral">${esc(env.ANTIGRAVITY_AGENT || DEFAULT_AGENT)}</span></div><p class="muted">The credential stays server-side and is never returned to the browser.</p><form method="post" action="/ui/agent/key"><label>Gemini API / authorization key</label><input type="password" name="api_key" required autocomplete="off" placeholder="Paste key from Google AI Studio"><div class="actions"><button type="submit">Save & verify</button><a class="button secondary" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Open Google AI Studio</a></div></form>${storedKey ? '<form method="post" action="/ui/agent/key/remove"><div class="actions"><button class="danger" type="submit">Remove dashboard credential</button></div></form>' : ""}</div></details></div>
<div class="card"><div class="toolbar"><div><h2>Research jobs</h2><p class="small muted" style="margin:5px 0 0">Showing the 100 most recent jobs. Expand any job for the full readable request, response, evidence and decision.</p></div><span class="small muted">Auto-refreshes every 15 seconds when no job is open</span></div><div class="jobs">${jobHtml}</div></div>${autoRefresh}`);
}

export async function handleUiShell(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const auth = await getUiAuth(env);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui/setup") && !auth) return setupPage();
  if (request.method === "GET" && url.pathname === "/ui/setup" && auth) return redirect("/");

  if (request.method === "POST" && url.pathname === "/ui/setup") {
    if (auth) return redirect("/");
    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (password.length < 10) return setupPage("Use a password of at least 10 characters.");
    if (password !== confirm) return setupPage("The two passwords do not match.");
    try {
      const saved = await saveUiAuth(env, password);
      return redirect("/", { "set-cookie": await sessionCookie(saved) });
    } catch (error) {
      return setupPage(error instanceof Error ? `Could not create the dashboard password: ${error.message}` : "Could not create the dashboard password.");
    }
  }

  if (request.method === "GET" && url.pathname === "/ui/agent") return agentPage(request, env);

  if (request.method === "POST" && url.pathname === "/ui/agent/key") {
    if (!auth || !(await hasUiSession(request, auth))) return redirect("/");
    const form = await request.formData();
    const key = String(form.get("api_key") ?? "").trim();
    if (!key) return agentPage(request, env, "Enter a Google credential.", true);
    const verified = await verifyGeminiKey(key);
    if (!verified.ok) return agentPage(request, env, verified.message, true);
    await env.DB.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('gemini_api_key', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).bind(key).run();
    return redirect("/ui/agent");
  }

  if (request.method === "POST" && url.pathname === "/ui/agent/key/remove") {
    if (!auth || !(await hasUiSession(request, auth))) return redirect("/");
    await env.DB.prepare("DELETE FROM app_settings WHERE key = 'gemini_api_key'").run();
    return redirect("/ui/agent");
  }

  return null;
}

export async function decorateDashboard(request: Request, response: Response): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/" || !response.headers.get("content-type")?.includes("text/html")) return response;
  const html = await response.text();
  if (!html.includes('action="/ui/logout"') || html.includes('href="/ui/agent"')) return new Response(html, response);
  const decorated = html.replace('<form method="post" action="/ui/logout">', '<div class="row"><a class="button secondary" href="/ui/agent">Antigravity jobs</a><form method="post" action="/ui/logout">').replace('</form></div>\n${message', '</form></div></div>\n${message');
  return new Response(decorated, { status: response.status, headers: response.headers });
}
