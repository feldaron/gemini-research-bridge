# ChatGPT GitHub Research Mailbox

This repository's GitHub Issues are the transport between ChatGPT Web and the Gemini Research Bridge. Cloudflare D1 remains the authoritative queue and review store. GitHub is only the mailbox, readable status surface, and audit trail.

## Architecture

```text
ChatGPT Web
  -> GitHub Issue
  -> GitHub Actions mailbox
  -> Cloudflare Worker / D1
  -> Antigravity managed agent
  -> Cloudflare Worker / D1 proposal
  -> GitHub Issue comment
  -> ChatGPT review
```

The bridge never gives Antigravity Supabase or LaptopValue write access. Research workers propose. A controller reviews. Only the LaptopValue side may commit accepted facts to LaptopValue.

## ChatGPT submission contract

A research issue may contain normal human-readable Markdown plus one hidden task block:

```html
<!-- gemini-research-bridge:task:v1
{"task":"Find a defensible measured web-browsing runtime for this exact configuration.","context":{"configuration_id":"...","model":"..."},"priority":0,"max_attempts":3}
-->
```

Supported fields are the same simple research input used by `POST /v1/research`:

- `task` — required plain-language research task.
- `context` — optional JSON context used for identity, scope and constraints.
- `instructions` — optional string or string array.
- `priority` — optional integer from -100 through 100.
- `max_attempts` — optional integer from 1 through 10.

The mailbox ignores a supplied `request_key` and always derives the canonical key `github-issue:<issue number>`. Editing or reopening the issue is therefore idempotent.

Only issues opened by the repository owner are allowed to submit work. This matters because the repository is public: everybody may read mailbox issues, but strangers cannot spend research capacity by opening a crafted issue.

## Progress and proposals

The issue-triggered Action submits the task immediately and posts a bridge acknowledgement with the D1 job ID.

A scheduled mailbox Action synchronizes active queue state and pending proposals back to the issue. Proposal comments translate the bridge JSON into readable sections for resolution, confidence, proposed value, reasoning, evidence, applicability and conflicts.

D1 is authoritative. GitHub comments are projections of D1 state and may lag by several minutes.

## Reviewing from ChatGPT Web

Only comments from the repository owner may change review state. The first line of the comment must be one of:

```text
/accept <proposal-id>
/reject <proposal-id>
/research-again <proposal-id>
```

`/accept` and `/reject` record the terminal bridge review and close the GitHub issue. `/research-again` rejects the current proposal, requeues the D1 job and keeps the issue open.

Acceptance in this bridge does **not** write to LaptopValue or Supabase.

## Antigravity execution

Cloudflare runs the Antigravity scheduler every minute. The scheduler uses Google's managed Antigravity agent in background mode and persists each Google interaction ID in D1. On later cron runs it heartbeats the bridge lease and polls the background interaction until it reaches a terminal state.

Default agent:

```text
antigravity-preview-05-2026
```

Default concurrency is 1 and can be raised with `ANTIGRAVITY_CONCURRENCY` up to the implementation limit of 5.

A Worker secret named `GEMINI_API_KEY` is required before real Antigravity jobs can start. When that secret is absent, queued jobs remain safely in D1 for another available worker.

## Public-repository implications

The repository is public, so issue titles, task context, research results and evidence posted into issues are publicly readable. Do not put secrets, personal data, private LaptopValue credentials, or confidential source material into mailbox issues.

The workflow restricts task submission and review commands to the repository owner, but that does not make issue contents private.

## Cost model

The mailbox uses standard GitHub-hosted Actions runners. GitHub documents standard runners as free and unlimited for public repositories. Larger GitHub-hosted runners are not covered by that public-repository allowance.

The bridge's own ongoing resources are Cloudflare Workers/D1 and the Google Gemini/Antigravity API. GitHub is intentionally used only as the ChatGPT-facing transport rather than as another database.

## Normal ChatGPT usage

The user should not have to format JSON manually. In an ordinary ChatGPT Web conversation, a controller can:

1. Convert the user's plain-language research request into the hidden issue task block.
2. Create the issue using the connected GitHub app.
3. Later read the issue comments to inspect progress or a returned proposal.
4. Independently validate the proposal and evidence.
5. Comment the appropriate review command.

The mailbox protocol is an implementation detail; the normal user interaction can remain as simple as: `Research this with Antigravity`, `check what Antigravity returned`, or `research this again`.
