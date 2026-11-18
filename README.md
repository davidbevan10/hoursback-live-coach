# Live Coach

Private live sales coach for David's Zoom calls (HoursBack). Zoom streams the live transcript to
this server; Claude reads it against the call's playbook and shows short cues on a private page
on the second monitor.

Hosted on Railway (project `hoursback-live-coach`, service `coach-server`, EU West), deployed
from `main` on every push.

## How it fits together

- `apps/server/src/sources/rtms.ts` - Zoom RTMS: joins the stream when Zoom's webhook fires.
- `apps/server/src/hub.ts` - one coaching session per Zoom stream, fans events out to the page.
- `apps/server/src/engine/` - when to evaluate, the cue call (prompt-cached playbooks,
  zod-validated cue, must cite a real playbook heading), and the coverage tracker.
- `apps/server/src/playbooks/` - Layer 1 frameworks and the read-only Supabase loader.
  See `docs/PLAYBOOKS.md` for where playbooks come from and why.
- `apps/server/src/web/page.ts` - the coach page (vanilla HTML + server-sent events).
- `eval/replay.ts` - replays a past call through the engine and writes a report to label.

## Settings (Railway variables)

| Variable | What it is |
|---|---|
| `ZM_RTMS_CLIENT`, `ZM_RTMS_SECRET` | Zoom app client ID and secret |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | Zoom app's webhook secret token |
| `ANTHROPIC_API_KEY` | Claude API key. Without it the server runs a stub model |
| `COACH_TOKEN` | Passphrase for the coach page. Without it the page is off |
| `HOURSBACK_DB_URL` | Read-only Postgres URL (`docs/sql/coach_reader.sql`). Without it, generic framework only |
| `CUE_MODEL`, `STATE_MODEL` | Model IDs (defaults Haiku for cues, Sonnet for coverage) |
| `CUE_RATE` | `conservative`, `balanced` or `proactive` (switchable on the page) |
| `HOST_NAME` | David's Zoom display name; everyone else is the prospect |
| `DATA_DIR` | Session logs (JSONL), on the Railway volume at `/data` |

## Local

`npm install`, then `cd apps/server && COACH_TOKEN=dev npx tsx scripts/demo.ts` and open
`http://localhost:8080/?key=dev` for a full loop with a fictional call and no Zoom.

Never commit `.env`, `data/`, playbooks, transcripts or `eval/out`/`eval/gold` (prospect data).
