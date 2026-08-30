# Cloudflare setup

The repository and Worker are intentionally standalone. Do not connect this service to Laptop Value Supabase.

## 1. Create the D1 database

Create a D1 database named `gemini-research-bridge`.

Copy its database ID into `wrangler.toml` by uncommenting the `[[d1_databases]]` block and setting:

- `binding = "DB"`
- `database_name = "gemini-research-bridge"`
- `database_id = "<the database id>"`

## 2. Apply the schema

Run:

```bash
npm install
npx wrangler d1 migrations apply gemini-research-bridge --remote
```

This creates the standalone `jobs` queue and its indexes.

## 3. Set the bridge secret

Create a long random token and store it only as the Worker secret `BRIDGE_TOKEN`:

```bash
npx wrangler secret put BRIDGE_TOKEN
```

Do not commit the token.

## 4. Deploy to the existing Worker

```bash
npm run deploy
```

The configured Worker name is `gemini-research-bridge`, so Wrangler updates that Worker rather than creating Laptop Value infrastructure.

## 5. Verify

Unauthenticated health check:

```bash
curl https://<worker-host>/health
```

Expected response:

```json
{"ok":true,"service":"gemini-research-bridge"}
```

Then submit and claim one disposable authenticated test job before connecting the local Gemini worker.
