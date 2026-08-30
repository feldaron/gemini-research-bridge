import app from "./app";
import { runAntigravityCycle } from "./antigravity";
import { handleUiShell, loadStoredGeminiKey } from "./ui-shell";

interface Env {
  DB: D1Database;
  CLIENT_TOKEN: string;
  WORKER_TOKEN: string;
  GEMINI_API_KEY?: string;
  ANTIGRAVITY_AGENT?: string;
  ANTIGRAVITY_CONCURRENCY?: string;
}

async function runtimeEnv(env: Env): Promise<Env> {
  const storedKey = await loadStoredGeminiKey(env);
  if (!storedKey) return env;
  return { ...env, GEMINI_API_KEY: storedKey };
}

async function addAgentLink(request: Request, response: Response): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/" || !response.headers.get("content-type")?.includes("text/html")) return response;
  const html = await response.text();
  if (!html.includes('action="/ui/logout"') || html.includes('href="/ui/agent"')) {
    return new Response(html, { status: response.status, headers: response.headers });
  }
  const decorated = html.replace(
    '<form method="post" action="/ui/logout">',
    '<a class="button secondary" href="/ui/agent" style="margin-right:8px">Antigravity agent</a><form method="post" action="/ui/logout">',
  );
  return new Response(decorated, { status: response.status, headers: response.headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const activeEnv = await runtimeEnv(env);
    const shell = await handleUiShell(request, activeEnv);
    if (shell) return shell;

    let response = await app.fetch(request, activeEnv);
    response = await addAgentLink(request, response);

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health" && response.headers.get("content-type")?.includes("application/json")) {
      try {
        const data = await response.clone().json() as Record<string, unknown>;
        delete data.cloud_gemini;
        data.cloud_antigravity = Boolean(activeEnv.GEMINI_API_KEY);
        data.antigravity_agent = activeEnv.ANTIGRAVITY_AGENT || "antigravity-preview-05-2026";
        return new Response(JSON.stringify(data, null, 2), {
          status: response.status,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      } catch {
        return response;
      }
    }
    return response;
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => runAntigravityCycle(await runtimeEnv(env)))());
  },
};
