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

type AgentRunRow = {
  id: string;
  job_id: string;
  interaction_id: string;
  status: string;
  environment_id: string | null;
  error: string | null;
  started_at: string;
  last_polled_at: string | null;
  completed_at: string | null;
  job_payload: string | null;
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

function page(title: string, body: string, refresh = false): Response {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="15">' : ""}
<title>${esc(title)} · Gemini Research Bridge</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}.shell{max-width:1100px;margin:0 auto;padding:28px 18px 64px}.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px}.top h1{font-size:22px;margin:0}.top p{margin:5px 0 0;color:#64748b;font-size:13px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 2px 10px rgba(15,23,42,.035)}.login{max-width:470px;margin:10vh auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.metric strong{display:block;font-size:24px}.metric span,.muted{color:#64748b}.small{font-size:12px}.pill{display:inline-block;padding:4px 9px;border-radius:999px;background:#eef2ff;font-size:12px}.ok{background:#ecfdf5}.bad{background:#fef2f2}.run{padding:12px;border:1px solid #e2e8f0;border-radius:10px;margin-top:9px}.row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}label{display:block;font-size:13px;font-weight:650;margin:12px 0 5px}input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;background:#fff;font:inherit}button,.button{appearance:none;border:0;border-radius:8px;background:#172033;color:#fff;padding:9px 13px;font-weight:600;cursor:pointer;text-decoration:none;font-size:13px}.secondary{background:#475569}.danger{background:#991b1b}.ghost{background:#e2e8f0;color:#172033}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}.flash{background:#ecfdf5;border:1px solid #a7f3d0;padding:10px;border-radius:8px;margin-bottom:14px}.error{background:#fef2f2;border-color:#fecaca}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.task{white-space:pre-wrap;margin-top:7px}.status-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#22c55e}.status-dot.off{background:#94a3b8}@media(max-width:650px){.top{align-items:flex-start;flex-direction:column}}
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

function taskFromPayload(payload: string | null): string {
  if (!payload) return "";
  try {
    const parsed = JSON.parse(payload) as { task?: unknown };
    return typeof parsed.task === "string" ? parsed.task : payload;
  } catch {
    return payload;
  }
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
  const runs = await env.DB.prepare(`
    SELECT ar.id, ar.job_id, ar.interaction_id, ar.status, ar.environment_id, ar.error,
           ar.started_at, ar.last_polled_at, ar.completed_at, j.payload AS job_payload
    FROM agent_runs ar
    LEFT JOIN jobs j ON j.id = ar.job_id
    ORDER BY ar.started_at DESC
    LIMIT 50
  `).all<AgentRunRow>();
  const runHtml = runs.results.map((run) => `<div class="run">
<div class="row"><span class="pill ${run.status === "completed" ? "ok" : run.status === "failed" ? "bad" : ""}">${esc(run.status)}</span><span class="small muted">${esc(run.started_at)}</span></div>
<div class="task"><strong>${esc(taskFromPayload(run.job_payload))}</strong></div>
<div class="small mono">Interaction: ${esc(run.interaction_id)}</div>
<div class="small muted">Job ${esc(run.job_id)}${run.environment_id ? ` · environment ${esc(run.environment_id)}` : ""}</div>
<div class="small muted">Last poll: ${esc(run.last_polled_at ?? "—")}${run.completed_at ? ` · completed ${esc(run.completed_at)}` : ""}</div>
${run.error ? `<div class="small" style="color:#991b1b;margin-top:6px">${esc(run.error)}</div>` : ""}
</div>`).join("") || '<p class="muted">No Antigravity runs yet.</p>';

  return page("Antigravity agent", `<div class="top"><div><h1>Antigravity agent</h1><p>Google-hosted managed research worker · refreshes every 15 seconds</p></div><div class="actions"><a class="button ghost" href="/">Dashboard</a></div></div>
${message ? `<div class="flash ${isError ? "error" : ""}">${esc(message)}</div>` : ""}
<div class="grid">
<div class="card metric"><strong><i class="status-dot ${activeKey ? "" : "off"}"></i> ${activeKey ? "Connected" : "Disconnected"}</strong><span>Google authentication</span></div>
<div class="card metric"><strong>${esc(env.ANTIGRAVITY_AGENT || DEFAULT_AGENT)}</strong><span>Managed agent</span></div>
<div class="card metric"><strong>${esc(String(runs.results.filter((run) => run.status === "in_progress").length))}</strong><span>Running now</span></div>
</div>
<div class="card"><h2 style="margin-top:0">Google authentication</h2>
<p class="muted">The Antigravity managed agent uses the Gemini Interactions API. For this single-user bridge, the simplest authentication is an AI Studio authorization key. Paste it here once; it stays server-side in Cloudflare D1 and is never returned to the browser.</p>
<div class="row"><span class="pill ${activeKey ? "ok" : "bad"}">${esc(source)}</span><span class="small muted">fingerprint ${esc(fingerprint)}</span></div>
<form method="post" action="/ui/agent/key"><label>Gemini API / authorization key</label><input type="password" name="api_key" required autocomplete="off" placeholder="Paste key from Google AI Studio"><div class="actions"><button type="submit">Save & verify</button><a class="button secondary" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Open Google AI Studio</a></div></form>
${storedKey ? '<form method="post" action="/ui/agent/key/remove"><div class="actions"><button class="danger" type="submit">Remove dashboard credential</button></div></form>' : ""}
<p class="small muted">Google also supports OAuth for the Gemini API, but that requires a Google Cloud OAuth client and consent configuration. The API/auth-key flow is the official simplest path and works for unattended Cloudflare execution.</p>
</div>
<div class="card"><h2 style="margin-top:0">Agent activity</h2><p class="small muted">These are the actual background Antigravity interactions persisted by the bridge.</p>${runHtml}</div>`, true);
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
    const saved = await saveUiAuth(env, password);
    return redirect("/", { "set-cookie": await sessionCookie(saved) });
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
  const decorated = html.replace('<form method="post" action="/ui/logout">', '<div class="row"><a class="button secondary" href="/ui/agent">Antigravity agent</a><form method="post" action="/ui/logout">').replace('</form></div>\n${message', '</form></div></div>\n${message');
  return new Response(decorated, { status: response.status, headers: response.headers });
}
