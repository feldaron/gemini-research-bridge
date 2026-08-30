# Gemini Research Bridge

Standalone Cloudflare Worker + D1 service for handing research tasks to Gemini or any other research model and returning **proposals** for a separate controller to review.

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
Gemini worker or manual research model
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

## Simple API

The normal input API intentionally requires very little formatting:

`POST /v1/research`

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

## Automated Gemini worker

The Windows runner in [`worker/worker.ps1`](worker/worker.ps1):

- claims a leased job from the Worker;
- receives a ready-made prompt from the bridge;
- sends that prompt to the locally authenticated `agy` CLI;
- parses Gemini's JSON result;
- submits the result as a pending proposal;
- heartbeats while long research jobs are running;
- cannot access Supabase.

This keeps the Google AI Pro login on the local Windows machine while the queue/control plane remains on Cloudflare.

## Authentication

Two independent Cloudflare Worker secrets are used:

- `CLIENT_TOKEN` — controller, review and JSON import/export access.
- `WORKER_TOKEN` — local Gemini execution worker access.

Do not reuse the same value for both roles and do not commit either token.

## Cloudflare resources

The service expects:

- Worker name: `gemini-research-bridge`
- D1 binding: `DB`
- D1 database: `gemini-research-bridge`
- Worker secrets: `CLIENT_TOKEN`, `WORKER_TOKEN`

Database migrations live in `migrations/`; Worker source is in `src/`.

See [`docs/SETUP.md`](docs/SETUP.md) for deployment setup.
