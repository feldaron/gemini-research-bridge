interface Env {
  DB: D1Database;
}

type UiAuth = {
  salt: string;
  hash: string;
  iterations: number;
};

const encoder = new TextEncoder();
const SESSION_COOKIE = "grb_ui";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const PBKDF2_ITERATIONS = 100000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 24): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToHex(data);
}

async function derivePasswordHash(password: string, saltHex: string): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g)?.map((part) => parseInt(part, 16)) ?? []);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

async function sessionSignature(auth: UiAuth, expiry: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(auth.hash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(expiry));
  return bytesToHex(new Uint8Array(signature));
}

async function sessionCookie(auth: UiAuth): Promise<string> {
  const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const signature = await sessionSignature(auth, expiry);
  return `${SESSION_COOKIE}=${expiry}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function setupError(message: string, status = 400): Response {
  const safe = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard setup</title></head><body style="font-family:system-ui;max-width:520px;margin:10vh auto;padding:20px"><h1>Gemini Research Bridge</h1><p>${safe}</p><p><a href="/ui/setup">Return to setup</a></p></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleSetupFix(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/ui/setup") return null;

  try {
    const existing = await env.DB.prepare("SELECT 1 AS present FROM app_settings WHERE key = 'ui_auth'").first();
    if (existing) return new Response(null, { status: 303, headers: { location: "/" } });

    const form = await request.formData();
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (password.length < 10) return setupError("Use a password of at least 10 characters.");
    if (password !== confirm) return setupError("The two passwords do not match.");

    const salt = randomHex(24);
    const hash = await derivePasswordHash(password, salt);
    const auth: UiAuth = { salt, hash, iterations: PBKDF2_ITERATIONS };

    await env.DB.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('ui_auth', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).bind(JSON.stringify(auth)).run();

    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": await sessionCookie(auth),
      },
    });
  } catch (error) {
    console.error("UI setup failed", error);
    return setupError("The dashboard could not create the password. The error has been contained instead of returning a Cloudflare 1101.", 500);
  }
}
