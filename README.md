# Gemini Research Bridge

Standalone Cloudflare Worker + D1 service for handing research tasks to Antigravity, Gemini or another research model and returning **proposals** for a separate controller to review.

Canonical endpoint and dashboard: `https://gemini-research-bridge.laptopvalue.co.uk`

This repository is deliberately independent of Laptop Value and Supabase. The bridge has no Supabase credentials and cannot write canonical facts.

## Trust model

```text
Controller (for example ChatGPT)
        |
        | simple research task + optional context
        v
Cloudflare Worker + D1
        |
        | generated research prompt
        v
Antigravity managed agent / optional worker / manual model
        |
        | structured proposed resolution + evidence
        v
Cloudflare Worker + D1
        |
        | pending proposal
        v
Controller reviews and decides what, if anything, is written elsewhere
```

**Research workers propose. Controllers approve. The bridge never approves its own research.**

## ChatGPT Web mailbox

ChatGPT Web can use the connected GitHub app as the bridge transport without requiring a private ChatGPT MCP app.

Research tasks are created as repository issues containing a hidden machine-readable task block. GitHub Actions submits the task to Cloudflare/D1, synchronizes progress and Antigravity proposals back into readable issue comments, and accepts owner-only review commands such as `/accept`, `/reject` and `/research-again`.

D1 remains authoritative; GitHub Issues are only the ChatGPT-facing mailbox and audit trail.

See [`docs/chatgpt-github-mailbox.md`](docs/chatgpt-github-mailbox.md) for the complete protocol and public-repository security model.

## Cloud Antigravity worker

Cloudflare runs a scheduled research cycle every minute. The default worker is Google's managed Antigravity agent:

```text
antigravity-preview-05-2026
```

Each research run is started in background mode. Its Google interaction ID and bridge claim are persisted in D1, so later Cloudflare cron invocations can heartbeat the queue lease, poll the remote agent and submit the eventual structured proposal. The user's computer does not need to be online.

A Worker secret named `GEMINI_API_KEY` is required for real Antigravity execution. Default concurrency is one active managed-agent run and can be adjusted with `ANTIGRAVITY_CONCURRENCY`.

The older Windows [`worker/worker.ps1`](worker/worker.ps1) remains an optional execution path; it is not required for the cloud workflow.

## Dashboard

The canonical domain serves a server-rendered research control centre. The UI translates queue/proposal JSON into readable progress, evidence and review views and also supports the manual JSON workflow.

Dashboard authentication uses a separate UI password stored as a salted PBKDF2 hash in D1. The browser receives an HttpOnly session cookie; the UI password or controller token is not embedded in browser JavaScript.

## Simple API

The normal input API intentionally requires very little formatting:

`POST https://gemini-research-bridge.laptopvalue.co.uk/v1/research`

```json
{
  "task": "Find a defensible measured web-browsing battery runtime for this exact laptop configuration.",
  "context": {
    "configuration_id": "optional-controller-id",
    "manufacturer": "Lenovo",
    "model": "optional model identity"
  },
  "request_key": "optional-deduplication-key"
}
```

Only `task` is required. The bridge automatically creates the detailed research rules, evidence requirements and strict JSON response schema when the task is claimed.

See [`docs/API.md`](docs/API.md) for the full API.

## Manual JSON workflow

A model does **not** need API access.

1. `POST /v1/offline/export` reserves a batch and downloads a self-contained JSON file.
2. Give that entire JSON file to the research model.
3. The JSON itself tells the model exactly how to research and exactly how to format the response.
4. Upload the returned JSON to `POST /v1/offline/import`.
5. Imported answers become pending proposals for controller review.

The same service also supports importing/exporting simple task-definition JSON using `/v1/research/import` and `/v1/research/export`.

## Authentication

Cloudflare secrets are role-separated:

- `CLIENT_TOKEN` — controller, review and JSON import/export access.
- `WORKER_TOKEN` — research-worker claim/proposal access.
- `GEMINI_API_KEY` — Google API authentication for the cloud Antigravity managed agent.

Do not reuse role tokens and do not commit any secret.

The public GitHub mailbox additionally restricts task submission and review commands to the repository owner. Public issue contents are still world-readable, so secrets and confidential data must never be placed in mailbox issues.

## Cloudflare resources

The service uses:

- Canonical domain: `https://gemini-research-bridge.laptopvalue.co.uk`
- Worker name: `gemini-research-bridge`
- D1 binding: `DB`
- D1 database: `gemini-research-bridge`
- Cron: every minute
- Managed agent: `antigravity-preview-05-2026`

Database migrations live in `migrations/`; Worker source is in `src/`.

See [`docs/SETUP.md`](docs/SETUP.md) for deployment setup.
