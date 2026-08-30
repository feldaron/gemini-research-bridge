import bridge from "./index";

interface Env {
  DB: D1Database;
  CLIENT_TOKEN: string;
  WORKER_TOKEN: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type UiAuth = {
  salt: string;
  hash: string;
  iterations: number;
};

type JobRow = {
  id: string;
  request_key: string | null;
  kind: string;
  payload: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  claimed_by: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type ProposalViewRow = {
  id: string;
  job_id: string;
  source_type: string;
  source_id: string | null;
  result: string;
  review_status: string;
  reviewed_by: string | null;
  review_notes: string | null;
  created_at: string;
  reviewed_at: string | null;
  job_payload: string;
  request_key: string | null;
};

const textEncoder = new TextEncoder();
const SESSION_COOKIE = "grb_ui";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

async function getUiAuth(env: Env): Promise<UiAuth | null> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'ui_auth'")
    .first<{ value: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as UiAuth;
    if (!parsed.salt || !parsed.hash || !parsed.iterations) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveUiAuth(env: Env, password: string): Promise<UiAuth> {
  const iterations = 120000;
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

async function verifyUiPassword(password: string, auth: UiAuth): Promise<boolean> {
  const candidate = await derivePasswordHash(password, auth.salt, auth.iterations);
  return constantTimeEqual(candidate, auth.hash);
}

async function sessionSignature(auth: UiAuth, expiry: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(auth.hash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
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
  const expected = await sessionSignature(auth, expiry);
  return constantTimeEqual(signature, expected);
}

function basePage(title: string, body: string, refresh = false): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="20">' : ""}
<title>${htmlEscape(title)} · Gemini Research Bridge</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}
*{box-sizing:border-box}body{margin:0}.shell{max-width:1180px;margin:0 auto;padding:28px 18px 64px}.top{display:flex;gap:16px;align-items:center;justify-content:space-between;margin-bottom:24px}.brand h1{font-size:22px;margin:0}.brand p{margin:4px 0 0;color:#64748b;font-size:13px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(15,23,42,.035);margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.metric strong{display:block;font-size:28px}.metric span{font-size:12px;color:#64748b}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pill{display:inline-block;padding:4px 9px;border-radius:999px;background:#eef2ff;font-size:12px}.pill.queued{background:#fff7ed}.pill.claimed{background:#eff6ff}.pill.completed,.pill.accepted{background:#ecfdf5}.pill.failed,.pill.rejected{background:#fef2f2}.muted{color:#64748b}.small{font-size:12px}.jobs,.proposal{display:grid;gap:10px}.job{padding:13px;border:1px solid #e2e8f0;border-radius:10px}.job h3,.proposal h3{margin:0 0 7px;font-size:15px}.task{white-space:pre-wrap}.evidence{border-left:3px solid #cbd5e1;padding-left:12px;margin:10px 0}.evidence a{word-break:break-all}.proposal{border:1px solid #e2e8f0;border-radius:12px;padding:15px}.proposal-value{background:#f8fafc;padding:10px;border-radius:8px;white-space:pre-wrap}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}button,.button{appearance:none;border:0;border-radius:8px;background:#172033;color:#fff;padding:9px 13px;font-weight:600;cursor:pointer;text-decoration:none;font-size:13px}.secondary{background:#475569}.danger{background:#991b1b}.ghost{background:#e2e8f0;color:#172033}input,textarea,select{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;background:white;font:inherit}textarea{min-height:100px;resize:vertical}label{display:block;font-size:13px;font-weight:650;margin:12px 0 5px}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.login{max-width:460px;margin:10vh auto}.status-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#22c55e}.status-dot.off{background:#94a3b8}.section-title{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:12px}.section-title h2{font-size:17px;margin:0}details{margin-top:8px}pre{overflow:auto;background:#0f172a;color:#e2e8f0;padding:10px;border-radius:8px;font-size:11px}.flash{background:#ecfdf5;border:1px solid #a7f3d0;padding:10px;border-radius:8px;margin-bottom:14px}@media(max-width:700px){.two{grid-template-columns:1fr}.top{align-items:flex-start}.shell{padding-top:18px}}
</style>
</head><body><main class="shell">${body}</main></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function setupPage(error = ""): Response {
  return basePage("Set up dashboard", `<div class="login card">
<div class="brand"><h1>Gemini Research Bridge</h1><p>First-time dashboard setup</p></div>
${error ? `<p class="flash">${htmlEscape(error)}</p>` : ""}
<p class="muted">Choose a separate password for this UI. To prevent somebody else claiming first setup, confirm the existing controller token once. The UI password is hashed server-side and is never embedded in browser JavaScript.</p>
<form method="post" action="/ui/setup">
<label>Controller token</label><input type="password" name="controller_token" required autocomplete="off">
<label>New UI password</label><input type="password" name="password" minlength="10" required autocomplete="new-password">
<label>Confirm UI password</label><input type="password" name="confirm" minlength="10" required autocomplete="new-password">
<p><button type="submit">Create dashboard password</button></p>
</form></div>`);
}

function loginPage(error = ""): Response {
  return basePage("Sign in", `<div class="login card">
<div class="brand"><h1>Gemini Research Bridge</h1><p>Research control centre</p></div>
${error ? `<p class="flash">${htmlEscape(error)}</p>` : ""}
<form method="post" action="/ui/login">
<label>UI password</label><input type="password" name="password" required autofocus autocomplete="current-password">
<p><button type="submit">Sign in</button></p>
</form></div>`);
}

function parseJson(value: string): JsonValue | null {
  try { return JSON.parse(value) as JsonValue; } catch { return null; }
}

function taskFromPayload(payload: string): string {
  const parsed = parseJson(payload);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.task === "string") return parsed.task;
  return payload;
}

function contextFromPayload(payload: string): JsonValue | null {
  const parsed = parseJson(payload);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "context" in parsed) return parsed.context;
  return null;
}

function prettyValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

async function dashboardPage(env: Env, message = ""): Promise<Response> {
  const counts = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all<{ status: string; count: number }>();
  const reviewCounts = await env.DB.prepare("SELECT review_status AS status, COUNT(*) AS count FROM proposals GROUP BY review_status").all<{ status: string; count: number }>();
  const jobs = await env.DB.prepare("SELECT * FROM jobs ORDER BY CASE status WHEN 'claimed' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, priority DESC, created_at DESC LIMIT 80").all<JobRow>();
  const pending = await env.DB.prepare(`
    SELECT p.*, j.payload AS job_payload, j.request_key
    FROM proposals p JOIN jobs j ON j.id = p.job_id
    WHERE p.review_status = 'pending'
    ORDER BY p.created_at ASC LIMIT 50
  `).all<ProposalViewRow>();

  const countMap: Record<string, number> = { queued: 0, claimed: 0, completed: 0, failed: 0 };
  for (const row of counts.results) countMap[row.status] = Number(row.count);
  const reviewMap: Record<string, number> = { pending: 0, accepted: 0, rejected: 0 };
  for (const row of reviewCounts.results) reviewMap[row.status] = Number(row.count);

  const jobHtml = jobs.results.map((job) => `<div class="job">
<div class="row"><span class="pill ${htmlEscape(job.status)}">${htmlEscape(job.status)}</span>${job.claimed_by ? `<span class="small muted">worker: ${htmlEscape(job.claimed_by)}</span>` : ""}<span class="small muted">attempt ${job.attempts}/${job.max_attempts}</span><span class="small muted">priority ${job.priority}</span></div>
<h3>${htmlEscape(taskFromPayload(job.payload))}</h3>
${job.heartbeat_at ? `<div class="small muted">Heartbeat ${htmlEscape(job.heartbeat_at)} · lease ${htmlEscape(job.lease_expires_at ?? "")}</div>` : ""}
${job.error ? `<div class="small" style="color:#991b1b">${htmlEscape(job.error)}</div>` : ""}
<details><summary class="small muted">Context / raw task</summary><pre>${htmlEscape(JSON.stringify({ context: contextFromPayload(job.payload), request_key: job.request_key, id: job.id }, null, 2))}</pre></details>
</div>`).join("") || '<p class="muted">No jobs yet.</p>';

  const proposalHtml = pending.results.map((row) => {
    const result = parseJson(row.result);
    const object = result && typeof result === "object" && !Array.isArray(result) ? result : {};
    const evidence = Array.isArray(object.evidence) ? object.evidence : [];
    const evidenceHtml = evidence.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return "";
      const e = item as { [key: string]: JsonValue };
      return `<div class="evidence"><strong>${htmlEscape(e.source_title ?? "Source")}</strong> <span class="pill">${htmlEscape(e.source_type ?? "")}</span><br>
<a href="${htmlEscape(e.url ?? "#")}" target="_blank" rel="noreferrer">${htmlEscape(e.url ?? "")}</a>
<div class="task">${htmlEscape(e.evidence_text ?? "")}</div><div class="small muted">Applies to: ${htmlEscape(e.applies_to ?? "")} · ${htmlEscape(e.applicability ?? "")}</div></div>`;
    }).join("");
    return `<div class="proposal">
<div class="row"><span class="pill ${htmlEscape(String(object.resolution ?? ""))}">${htmlEscape(object.resolution ?? "proposal")}</span><span class="pill">confidence ${htmlEscape(object.confidence ?? "")}</span><span class="small muted">${htmlEscape(row.source_id ?? row.source_type)}</span></div>
<h3>${htmlEscape(taskFromPayload(row.job_payload))}</h3>
<div class="proposal-value"><strong>Proposed value</strong><br>${htmlEscape(prettyValue(object.proposed_value ?? null))}</div>
<p>${htmlEscape(object.reasoning ?? "")}</p>${evidenceHtml}
${Array.isArray(object.conflicts) && object.conflicts.length ? `<p><strong>Conflicts:</strong> ${htmlEscape(prettyValue(object.conflicts))}</p>` : ""}
<div class="actions">
<form method="post" action="/ui/proposals/${htmlEscape(row.id)}/accept"><button>Mark accepted</button></form>
<form method="post" action="/ui/proposals/${htmlEscape(row.id)}/reject"><button class="danger">Reject</button></form>
<form method="post" action="/ui/proposals/${htmlEscape(row.id)}/requeue"><button class="secondary">Reject & research again</button></form>
</div><div class="small muted">Acceptance only records bridge review state; it does not write to LaptopValue/Supabase.</div>
</div>`;
  }).join("") || '<p class="muted">Nothing waiting for review.</p>';

  const body = `<div class="top"><div class="brand"><h1>Gemini Research Bridge</h1><p>Cloudflare research control centre · auto-refreshes every 20 seconds</p></div><form method="post" action="/ui/logout"><button class="ghost">Sign out</button></form></div>
${message ? `<div class="flash">${htmlEscape(message)}</div>` : ""}
<div class="grid">
<div class="card metric"><strong>${countMap.queued}</strong><span>Queued</span></div>
<div class="card metric"><strong>${countMap.claimed}</strong><span>Researching / claimed</span></div>
<div class="card metric"><strong>${reviewMap.pending}</strong><span>Awaiting review</span></div>
<div class="card metric"><strong>${countMap.failed}</strong><span>Failed</span></div>
<div class="card metric"><strong>${reviewMap.accepted}</strong><span>Accepted proposals</span></div>
<div class="card metric"><strong>${countMap.completed}</strong><span>Completed jobs</span></div>
</div>
<div class="card"><div class="section-title"><h2>Cloud worker</h2><span><i class="status-dot ${env.GEMINI_API_KEY ? "" : "off"}"></i> ${env.GEMINI_API_KEY ? `Gemini API ready · ${htmlEscape(env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL)}` : "Gemini API key not installed"}</span></div><p class="small muted">Cloudflare checks the queue every minute. This continues when your computer is off. The local Windows worker remains optional.</p></div>
<div class="two">
<div class="card"><div class="section-title"><h2>New research task</h2></div><form method="post" action="/ui/research">
<label>Task</label><textarea name="task" required placeholder="Find a defensible measured web-browsing runtime for this exact configuration."></textarea>
<label>Context</label><textarea name="context" placeholder='Optional JSON, or ordinary notes. Example: {"configuration_id":"...","model":"..."}'></textarea>
<div class="two"><div><label>Priority</label><input type="number" name="priority" value="0" min="-100" max="100"></div><div><label>Max attempts</label><input type="number" name="max_attempts" value="3" min="1" max="10"></div></div>
<label>Request key</label><input name="request_key" placeholder="Optional deduplication key">
<p><button type="submit">Add to queue</button></p></form></div>
<div class="card"><div class="section-title"><h2>Manual JSON</h2></div><p class="muted small">For a model with no API access: download a self-contained batch, give it to the model, then upload the returned proposal JSON.</p>
<form method="post" action="/ui/offline/export"><div class="two"><div><label>Jobs</label><input type="number" name="limit" value="20" min="1" max="200"></div><div><label>Researcher</label><input name="researcher" value="manual-model"></div></div><p><button class="secondary">Download research JSON</button></p></form>
<form method="post" action="/ui/offline/import" enctype="multipart/form-data"><label>Returned proposal JSON</label><input type="file" name="file" accept="application/json,.json" required><p><button class="secondary">Upload proposal JSON</button></p></form></div>
</div>
<div class="card"><div class="section-title"><h2>Awaiting review</h2><span class="muted small">${reviewMap.pending} pending</span></div><div class="jobs">${proposalHtml}</div></div>
<div class="card"><div class="section-title"><h2>Queue & progress</h2><span class="muted small">latest 80 jobs</span></div><div class="jobs">${jobHtml}</div></div>`;
  return basePage("Dashboard", body, true);
}

async function requireUi(request: Request, env: Env): Promise<{ auth: UiAuth; response?: Response }> {
  const auth = await getUiAuth(env);
  if (!auth) return { auth: { salt: "", hash: "", iterations: 1 }, response: setupPage() };
  if (!(await hasUiSession(request, auth))) return { auth, response: loginPage() };
  return { auth };
}

async function internalBridge(env: Env, path: string, method = "GET", data?: unknown, worker = false): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${worker ? env.WORKER_TOKEN : env.CLIENT_TOKEN}` });
  let body: string | undefined;
  if (data !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(data);
  }
  return bridge.fetch(new Request(`https://bridge.internal${path}`, { method, headers, body }), env);
}

async function handleUi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/ui/setup") {
    const existing = await getUiAuth(env);
    if (existing) return redirect("/");
    const form = await request.formData();
    const controller = String(form.get("controller_token") ?? "");
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (!env.CLIENT_TOKEN || !constantTimeEqual(controller, env.CLIENT_TOKEN)) return setupPage("Controller token was not accepted.");
    if (password.length < 10) return setupPage("Use a UI password of at least 10 characters.");
    if (password !== confirm) return setupPage("The two UI passwords do not match.");
    const auth = await saveUiAuth(env, password);
    return redirect("/", { "set-cookie": await sessionCookie(auth) });
  }

  if (request.method === "POST" && url.pathname === "/ui/login") {
    const auth = await getUiAuth(env);
    if (!auth) return redirect("/");
    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    if (!(await verifyUiPassword(password, auth))) return loginPage("Incorrect password.");
    return redirect("/", { "set-cookie": await sessionCookie(auth) });
  }

  if (request.method === "POST" && url.pathname === "/ui/logout") {
    return redirect("/", { "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }

  if (url.pathname === "/" && request.method === "GET") {
    const auth = await getUiAuth(env);
    if (!auth) return setupPage();
    if (!(await hasUiSession(request, auth))) return loginPage();
    return dashboardPage(env);
  }

  if (!url.pathname.startsWith("/ui/")) return null;
  const guarded = await requireUi(request, env);
  if (guarded.response) return guarded.response;

  if (request.method === "POST" && url.pathname === "/ui/research") {
    const form = await request.formData();
    const task = String(form.get("task") ?? "").trim();
    if (!task) return redirect("/");
    const contextText = String(form.get("context") ?? "").trim();
    let context: JsonValue | undefined;
    if (contextText) {
      try { context = JSON.parse(contextText) as JsonValue; }
      catch { context = { notes: contextText }; }
    }
    const payload = {
      task,
      context,
      request_key: String(form.get("request_key") ?? "").trim() || undefined,
      priority: Number(form.get("priority") ?? 0),
      max_attempts: Number(form.get("max_attempts") ?? 3),
    };
    const response = await internalBridge(env, "/v1/research", "POST", payload);
    if (!response.ok) return dashboardPage(env, `Could not add task: ${await response.text()}`);
    return redirect("/");
  }

  const review = url.pathname.match(/^\/ui\/proposals\/([0-9a-f-]+)\/(accept|reject|requeue)$/i);
  if (review && request.method === "POST") {
    const [, id, action] = review;
    const decision = action === "accept" ? "accepted" : "rejected";
    const response = await internalBridge(env, `/v1/proposals/${id}/review`, "POST", {
      decision,
      reviewer: "dashboard",
      notes: action === "requeue" ? "Rejected and returned for further research from dashboard." : `Reviewed from dashboard: ${action}.`,
      requeue: action === "requeue",
    });
    if (!response.ok) return dashboardPage(env, `Review failed: ${await response.text()}`);
    return redirect("/");
  }

  if (request.method === "POST" && url.pathname === "/ui/offline/export") {
    const form = await request.formData();
    return internalBridge(env, "/v1/offline/export", "POST", {
      limit: Number(form.get("limit") ?? 20),
      researcher: String(form.get("researcher") ?? "manual-model"),
      lease_seconds: 86400,
    });
  }

  if (request.method === "POST" && url.pathname === "/ui/offline/import") {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return dashboardPage(env, "Choose a JSON file to upload.");
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); }
    catch { return dashboardPage(env, "That file is not valid JSON."); }
    const response = await internalBridge(env, "/v1/offline/import", "POST", parsed);
    if (!response.ok) return dashboardPage(env, `Import failed: ${await response.text()}`);
    return redirect("/");
  }

  return new Response("Not found", { status: 404 });
}

function mcpTools() {
  return [
    {
      name: "research_submit",
      description: "Submit a simple research task to the Gemini Research Bridge. Use when external research should be delegated rather than answered immediately.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Research task in plain language." },
          context: { description: "Optional structured context for identity, scope, constraints, or source-system IDs." },
          instructions: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
          request_key: { type: "string", description: "Optional idempotency/deduplication key." },
          priority: { type: "integer", minimum: -100, maximum: 100 },
          max_attempts: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["task"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "research_jobs",
      description: "List research jobs and their queue/progress state.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["queued", "claimed", "completed", "failed"] },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "research_job_get",
      description: "Get one research job together with proposals returned for it.",
      inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "research_proposals",
      description: "List research proposals, normally proposals waiting for controller review.",
      inputSchema: {
        type: "object",
        properties: {
          review_status: { type: "string", enum: ["pending", "accepted", "rejected"], default: "pending" },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "research_proposal_review",
      description: "Accept or reject a pending research proposal. Acceptance records bridge review state only and never writes to LaptopValue/Supabase.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string" },
          decision: { type: "string", enum: ["accepted", "rejected"] },
          reviewer: { type: "string" },
          notes: { type: "string" },
          requeue: { type: "boolean", description: "When rejecting, put the job back in the research queue." },
        },
        required: ["proposal_id", "decision"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function mcpResponse(id: unknown, result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function mcpError(id: unknown, code: number, message: string, data?: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function validMcpOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "openai.com" || host.endsWith(".openai.com") || host === "gemini-research-bridge.laptopvalue.co.uk";
  } catch {
    return false;
  }
}

async function mcpCallTool(env: Env, name: string, args: Record<string, unknown>): Promise<{ response: Response; data: unknown }> {
  let response: Response;
  if (name === "research_submit") {
    response = await internalBridge(env, "/v1/research", "POST", args);
  } else if (name === "research_jobs") {
    const params = new URLSearchParams();
    if (args.status) params.set("status", String(args.status));
    params.set("kind", "research");
    if (args.limit) params.set("limit", String(args.limit));
    response = await internalBridge(env, `/v1/jobs?${params.toString()}`);
  } else if (name === "research_job_get") {
    response = await internalBridge(env, `/v1/jobs/${encodeURIComponent(String(args.job_id ?? ""))}`);
  } else if (name === "research_proposals") {
    const params = new URLSearchParams();
    params.set("review_status", String(args.review_status ?? "pending"));
    if (args.limit) params.set("limit", String(args.limit));
    response = await internalBridge(env, `/v1/proposals?${params.toString()}`);
  } else if (name === "research_proposal_review") {
    response = await internalBridge(env, `/v1/proposals/${encodeURIComponent(String(args.proposal_id ?? ""))}/review`, "POST", {
      decision: args.decision,
      reviewer: args.reviewer ?? "chatgpt",
      notes: args.notes,
      requeue: args.requeue,
    });
  } else {
    return { response: new Response(null, { status: 404 }), data: { error: "unknown_tool" } };
  }
  let data: unknown;
  try { data = await response.clone().json(); } catch { data = await response.text(); }
  return { response, data };
}

async function handleMcp(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return null;
  if (!validMcpOrigin(request)) return mcpError(null, -32000, "Invalid Origin");
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !constantTimeEqual(auth.slice(7), env.CLIENT_TOKEN ?? "")) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="Gemini Research Bridge"' },
    });
  }
  if (request.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST, GET" } });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, GET" } });

  let rpc: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try { rpc = await request.json(); }
  catch { return mcpError(null, -32700, "Parse error"); }
  if (rpc.jsonrpc !== "2.0" || !rpc.method) return mcpError(rpc.id, -32600, "Invalid Request");

  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (rpc.method === "ping") return mcpResponse(rpc.id, {});
  if (rpc.method === "initialize") {
    const requested = typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "2025-06-18";
    return mcpResponse(rpc.id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "gemini-research-bridge", title: "Gemini Research Bridge", version: "1.1.0" },
      instructions: "Use this bridge to delegate external research, inspect proposals, and record review decisions. Research workers only propose; acceptance here never writes to LaptopValue/Supabase.",
    });
  }
  if (rpc.method === "tools/list") return mcpResponse(rpc.id, { tools: mcpTools() });
  if (rpc.method === "tools/call") {
    const name = String(rpc.params?.name ?? "");
    const args = (rpc.params?.arguments && typeof rpc.params.arguments === "object" && !Array.isArray(rpc.params.arguments))
      ? rpc.params.arguments as Record<string, unknown>
      : {};
    const called = await mcpCallTool(env, name, args);
    return mcpResponse(rpc.id, {
      content: [{ type: "text", text: JSON.stringify(called.data, null, 2) }],
      structuredContent: called.data,
      isError: !called.response.ok,
    });
  }
  return mcpError(rpc.id, -32601, "Method not found");
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

async function callGemini(env: Env, prompt: string): Promise<JsonValue> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!response.ok) throw new Error(`Gemini API ${response.status}: ${(await response.text()).slice(0, 1500)}`);
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("Gemini returned no text result");
  try { return JSON.parse(stripJsonFence(text)) as JsonValue; }
  catch { throw new Error(`Gemini returned invalid JSON: ${text.slice(0, 1200)}`); }
}

async function runCloudGeminiOnce(env: Env): Promise<void> {
  if (!env.GEMINI_API_KEY || !env.WORKER_TOKEN) return;
  const claimResponse = await internalBridge(env, "/v1/worker/claim", "POST", { worker_id: "cloud-gemini", lease_seconds: 900 }, true);
  if (!claimResponse.ok) throw new Error(`claim failed: ${await claimResponse.text()}`);
  const claim = await claimResponse.json() as { job?: { id?: string; claim_token?: string; prompt?: string } | null };
  if (!claim.job?.id || !claim.job.claim_token || !claim.job.prompt) return;
  try {
    const result = await callGemini(env, claim.job.prompt);
    const proposed = await internalBridge(env, `/v1/worker/jobs/${claim.job.id}/propose`, "POST", {
      worker_id: "cloud-gemini",
      claim_token: claim.job.claim_token,
      result,
    }, true);
    if (!proposed.ok) throw new Error(`proposal rejected by bridge: ${await proposed.text()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "cloud_gemini_failed";
    await internalBridge(env, `/v1/worker/jobs/${claim.job.id}/fail`, "POST", {
      worker_id: "cloud-gemini",
      claim_token: claim.job.claim_token,
      error: message,
      retry: true,
      retry_after_seconds: 60,
    }, true);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const mcp = await handleMcp(request, env);
      if (mcp) return mcp;
      const url = new URL(request.url);
      const ui = await handleUi(request, env, url);
      if (ui) return ui;

      if (request.method === "GET" && url.pathname === "/health") {
        const response = await bridge.fetch(request, env);
        const data = await response.json() as Record<string, unknown>;
        return json({ ...data, dashboard: true, cloud_gemini: Boolean(env.GEMINI_API_KEY), mcp: "/mcp" }, response.status);
      }
      return bridge.fetch(request, env);
    } catch (error) {
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCloudGeminiOnce(env));
  },
};
