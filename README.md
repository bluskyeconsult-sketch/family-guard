# Family Guard API (Vercel)

A small set of serverless functions. The child phones talk only to these
endpoints, never to the database. The API uses the Supabase **service role**
to read and write the shared Family Tutor project. The service role key lives
only in Vercel environment settings.

## Endpoints

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/health` | anyone | liveness check, reveals nothing |
| GET | `/api/device/config` | child device token | the phone pulls its policy: DNS host, allowlist, screen time, quiet hours, hard-stop state, which extras are on |
| POST | `/api/device/ingest` | child device token | batched upload: `locations[]`, `status`, `usage[]`, `alerts[]`. Server computes geofence enter/exit, DNS-changed, VPN-detected and low-battery alerts |
| GET/POST | `/api/device/messages` | child device token | family messenger (text only), scoped to the child own threads |
| GET | `/api/cron/weekly` | Vercel Cron + `CRON_SECRET` | 30-day location cleanup, rebuild daily summaries, build weekly digest, optional email |

The **parent app does not use this API** — it talks to Supabase directly with
the parent sign-in, through row-level security.

## Auth

Every device request carries header `x-device-token: <token>`. The API calls
`guard_device_from_token`, which hashes the token and returns the device,
child and family. An unknown or missing token returns 401. The weekly cron is
protected by `CRON_SECRET` (sent by Vercel Cron as `Authorization: Bearer …`,
or as `x-cron-secret`).

## Environment variables (names only — set in Vercel)

- `SUPABASE_URL` (required)
- `SUPABASE_SERVICE_ROLE_KEY` (required, secret)
- `CRON_SECRET` (required, secret)
- `BREVO_API_KEY`, `DIGEST_FROM` (optional — weekly email; skipped if unset)

## Local type-check

```
npm install
npm run typecheck
```
