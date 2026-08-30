# Gemini Research Bridge

Standalone Cloudflare Worker queue service for research jobs.

This repository is deliberately independent of Laptop Value and Supabase. It owns its own API, Cloudflare Worker deployment, D1 database, authentication secret, and job lifecycle.

## API

Authenticated endpoints:

- `POST /v1/jobs` — submit a job
- `POST /v1/jobs/claim` — claim the next queued job
- `POST /v1/jobs/:id/heartbeat` — extend a claim lease
- `POST /v1/jobs/:id/complete` — complete a job with a result
- `POST /v1/jobs/:id/fail` — fail or retry a job
- `GET /v1/jobs/:id` — inspect job status
- `GET /v1/jobs/:id/result` — fetch the completed result

Unauthenticated endpoint:

- `GET /health` — service health

All `/v1/*` requests use `Authorization: Bearer <BRIDGE_TOKEN>`.

## Cloudflare resources

The Worker expects:

- Worker name: `gemini-research-bridge`
- D1 binding: `DB`
- Worker secret: `BRIDGE_TOKEN`

The D1 schema lives in `migrations/` and the Worker source lives in `src/`.
