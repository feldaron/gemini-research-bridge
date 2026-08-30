# API

The bridge has two authenticated roles:

- `CLIENT_TOKEN` — controller access for submitting research, inspecting jobs, exporting/importing JSON, and reviewing proposals.
- `WORKER_TOKEN` — execution access for the local Gemini worker to claim jobs and return proposals.

All authenticated requests use:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

`GET /health` is unauthenticated.

## Simple research API

This is the normal controller entrypoint. The caller does **not** need to construct the Gemini prompt or response schema.

### Submit one research task

`POST /v1/research`

Minimum body:

```json
{
  "task": "Find a defensible measured web-browsing battery runtime for this laptop."
}
```

Typical body:

```json
{
  "task": "Find a defensible measured web-browsing battery runtime for this exact configuration.",
  "context": {
    "configuration_id": "...",
    "manufacturer": "Lenovo",
    "model": "...",
    "known_evidence": []
  },
  "request_key": "laptop-value:configuration-id:measured-web-runtime"
}
```

Optional fields:

- `context` — any JSON context the researcher needs.
- `instructions` — one string or an array of extra task-specific rules.
- `request_key` — idempotency/deduplication key.
- `priority` — integer from -100 to 100.
- `max_attempts` — 1 to 10.

The bridge automatically adds the generic research rules, evidence requirements, unresolved/stop behaviour, and JSON response contract when the job is claimed or exported.

### Import many simple research tasks

`POST /v1/research/import`

```json
{
  "format": "gemini-research-bridge.research-input.v1",
  "jobs": [
    {
      "task": "Research task one",
      "context": {"id": "one"},
      "request_key": "one"
    },
    {
      "task": "Research task two",
      "context": {"id": "two"},
      "request_key": "two"
    }
  ]
}
```

Maximum: 500 jobs per import.

### Download simple jobs as JSON

`GET /v1/research/export?status=queued&limit=100`

The response is an attachment named `research-input.json` using the same `gemini-research-bridge.research-input.v1` format accepted by `/v1/research/import`.

This export is for moving/copying task definitions. It does **not** reserve jobs for manual research.

## Offline/manual research

Use this when the research model has no API access.

### Download a research batch

`POST /v1/offline/export`

```json
{
  "limit": 20,
  "lease_seconds": 86400,
  "researcher": "Gemini manual"
}
```

The bridge atomically reserves those jobs so an automated worker cannot claim them at the same time.

The downloaded JSON is self-contained. It includes:

- every research task and context;
- the generated research prompt;
- generic evidence and stop rules;
- a strict `response_format` section;
- required field names and enum values;
- an example output;
- `job_id` and temporary `claim_token` values required for safe import.

You can give the entire JSON file to a model with no additional prompt. The model is instructed to return one JSON file in format:

`gemini-research-bridge.offline-proposals.v1`

### Upload the model's proposal JSON

`POST /v1/offline/import`

The returned JSON must contain:

```json
{
  "format": "gemini-research-bridge.offline-proposals.v1",
  "batch_id": "copied-from-input",
  "researcher": "model-name",
  "proposals": [
    {
      "job_id": "copied-from-job",
      "claim_token": "copied-from-job",
      "result": {
        "resolution": "proposed",
        "proposed_value": "...",
        "evidence": [
          {
            "url": "https://...",
            "source_title": "...",
            "source_type": "manufacturer",
            "evidence_text": "...",
            "applies_to": "...",
            "applicability": "..."
          }
        ],
        "reasoning": "...",
        "confidence": "high",
        "conflicts": []
      }
    }
  ]
}
```

Imported results become **pending proposals**. They are never treated as approved facts automatically.

## Proposal review

### List proposals waiting for controller review

`GET /v1/proposals?review_status=pending&limit=100`

Each entry includes the proposal and its original job/context.

### Accept or reject a proposal

`POST /v1/proposals/:proposal_id/review`

Accept:

```json
{
  "decision": "accepted",
  "reviewer": "chatgpt-5.6",
  "notes": "Evidence and applicability verified."
}
```

Reject and optionally research again:

```json
{
  "decision": "rejected",
  "reviewer": "chatgpt-5.6",
  "notes": "Source is a different configuration.",
  "requeue": true
}
```

Acceptance only records the bridge review state. The bridge has no Supabase credentials and cannot write Laptop Value facts.

## Automated worker API

These endpoints require `WORKER_TOKEN`.

### Claim

`POST /v1/worker/claim`

```json
{
  "worker_id": "DESKTOP-1234",
  "lease_seconds": 300
}
```

A research claim includes a ready-to-send `prompt`, the output `response_format`, and a temporary `claim_token`.

### Heartbeat

`POST /v1/worker/jobs/:job_id/heartbeat`

```json
{
  "worker_id": "DESKTOP-1234",
  "claim_token": "...",
  "lease_seconds": 300
}
```

### Submit proposal

`POST /v1/worker/jobs/:job_id/propose`

```json
{
  "worker_id": "DESKTOP-1234",
  "claim_token": "...",
  "result": {
    "resolution": "unresolved",
    "proposed_value": null,
    "evidence": [],
    "reasoning": "Insufficient evidence.",
    "confidence": "low",
    "conflicts": []
  }
}
```

### Fail/retry

`POST /v1/worker/jobs/:job_id/fail`

```json
{
  "worker_id": "DESKTOP-1234",
  "claim_token": "...",
  "error": "temporary failure",
  "retry": true,
  "retry_after_seconds": 60
}
```

Claim tokens and leases prevent an old/stale worker from overwriting a job that has been reassigned.

## Inspection

- `GET /v1/jobs?status=queued&kind=research&limit=100`
- `GET /v1/jobs/:job_id`

## Advanced generic queue API

For non-research workloads only:

- `POST /v1/jobs`
- `POST /v1/jobs/import`

Normal research clients should prefer `/v1/research` because the bridge then owns the research contract and formatting.
