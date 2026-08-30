# Setup

The bridge is intentionally standalone. Do not connect it to Laptop Value Supabase and do not give the Gemini worker Supabase credentials.

## 1. D1 database

Create a D1 database named `gemini-research-bridge`.

Add it to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "gemini-research-bridge"
database_id = "<D1_DATABASE_ID>"
```

## 2. Apply migrations

From the repository:

```bash
npm install
npx wrangler d1 migrations apply gemini-research-bridge --remote
```

The migrations create:

- `jobs` — queue and lease state;
- `proposals` — research answers awaiting controller review;
- `job_events` — audit trail of submission, claims, retries and review decisions.

## 3. Create two independent Worker secrets

Controller secret:

```bash
npx wrangler secret put CLIENT_TOKEN
```

Gemini execution worker secret:

```bash
npx wrangler secret put WORKER_TOKEN
```

Use different long random values. Do not commit them.

The controller token can submit jobs, inspect results, perform manual JSON import/export and review proposals. The worker token can only use `/v1/worker/*` execution endpoints.

## 4. Deploy

```bash
npm run deploy
```

The configured Worker name is `gemini-research-bridge`.

## 5. Verify the Worker

Unauthenticated health check:

```bash
curl https://<worker-host>/health
```

Expected:

```json
{
  "ok": true,
  "service": "gemini-research-bridge",
  "version": 1
}
```

## 6. Test the simple controller API

```bash
curl -X POST "https://<worker-host>/v1/research" \
  -H "Authorization: Bearer <CLIENT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"task":"Research a harmless test question and return evidence."}'
```

No detailed Gemini prompt or output schema is needed in the request. The bridge creates those automatically.

## 7. Install the local Gemini worker

The worker requires a working locally authenticated `agy` command.

From a checkout of this repository:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\worker\install.ps1 -BridgeUrl "https://<worker-host>"
```

Set the worker token as a user environment variable:

```powershell
[Environment]::SetEnvironmentVariable("GEMINI_BRIDGE_WORKER_TOKEN", "<WORKER_TOKEN>", "User")
```

Optional model override:

```powershell
[Environment]::SetEnvironmentVariable("GEMINI_MODEL", "<agy-model-name>", "User")
```

If `GEMINI_MODEL` is not set, the worker allows `agy` to use its configured/default model.

Open a new PowerShell window and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\GeminiResearchBridge\worker.ps1
```

## 8. Manual/no-API model workflow

To reserve a batch for manual research:

```bash
curl -X POST "https://<worker-host>/v1/offline/export" \
  -H "Authorization: Bearer <CLIENT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"limit":20,"researcher":"manual-model"}' \
  -o research-batch.json
```

Give `research-batch.json` directly to the research model. The file contains the instructions and exact required response format.

When the model returns its JSON file:

```bash
curl -X POST "https://<worker-host>/v1/offline/import" \
  -H "Authorization: Bearer <CLIENT_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-binary @research-proposals.json
```

The imported results remain pending proposals until reviewed by the controller.

## Environment variables for the Windows worker

Required:

- `GEMINI_BRIDGE_URL`
- `GEMINI_BRIDGE_WORKER_TOKEN`

Optional:

- `GEMINI_MODEL`
- `GEMINI_WORKER_ID`
- `GEMINI_LEASE_SECONDS` (default 300)
- `GEMINI_HEARTBEAT_SECONDS` (default 60)
- `GEMINI_JOB_TIMEOUT_SECONDS` (default 3600)
- `GEMINI_IDLE_SECONDS` (default 5)
- `GEMINI_MAX_PROMPT_CHARACTERS` (default 100000)
