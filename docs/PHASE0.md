# Phase 0: RTMS spike

Goal: prove a meeting I host streams live transcript to my server, measure lag, and find the credit cost. No AI, no display.

Use a NEW Zoom app. Do not add RTMS to the existing HoursBack app: its webhook feeds the post-call transcript pipeline in production.

## 1. Run locally

```bash
npm install
cp apps/server/.env.example apps/server/.env     # fill in after step 2
npm run simulate -w @coach/server                # offline self-test, no Zoom needed
npm run dev -w @coach/server                     # listens on :8080
```

Zoom needs a public HTTPS URL. For the spike, tunnel it (nothing to deploy yet):

```bash
cloudflared tunnel --url http://localhost:8080     # or: ngrok http 8080
```

Webhook URL = `https://<tunnel-host>/webhook`.

## 2. Zoom Marketplace (marketplace.zoom.us, signed in as the account that hosts the calls)

1. Develop > Build App > **General App** > **User-managed**. Name: "HoursBack Live Coach (dev)".
2. App Credentials: copy Client ID and Client Secret into `.env` as `ZM_RTMS_CLIENT` and `ZM_RTMS_SECRET`.
3. Features > Access > **Event Subscriptions**: enable. Add endpoint URL (the tunnel `/webhook`). Copy the **Secret Token** into `.env` as `ZOOM_WEBHOOK_SECRET_TOKEN`. Click Validate (server must be running).
4. Add events: `meeting.rtms_started`, `meeting.rtms_stopped`.
5. Scopes: `meeting:read:meeting_transcript` (and `meeting:read:meeting_audio` only if Zoom refuses transcript without it; the spike needs no audio).
6. Add the app to your own account (Local Test > Add App / authorise). OAuth redirect URL can be a placeholder for dev.
7. **RTMS access:** the RTMS feature must be enabled for the app. If the RTMS option or events are missing, Zoom gates RTMS: request access via the Zoom Developer Forum with the use case ("live coaching for my own sales calls"), and check the Developer Pack and credit pricing in the Marketplace billing page. Record the cost per hour here: ______

## 3. Zoom web portal settings (zoom.us > Settings)

1. Meeting > In Meeting (Advanced) > **Share realtime meeting content with apps**: on.
2. Same section: **Auto-start apps that access shared realtime meeting content** > add the app (user level for you). If host approval is required, auto-start will not fire: turn approval off for your own app.
3. Make sure cloud/live transcription is on for the meeting (Settings > Recording > Audio transcript). RTMS transcript depends on it being generated.

## 4. Test call

1. Start a meeting you host. Join from a second device or ask someone to talk.
2. Expect `data/<timestamp>_<uuid>.jsonl` to appear within seconds and the Zoom "Active Apps" notifier to show.
3. Run for 10 minutes with normal speech, including interruptions and a 20 second silence.
4. `npm run summarise -w @coach/server -- data/<file>.jsonl`

## 5. Stopwatch lag test (reliable even if the SDK timestamp is not wall-clock)

Say a distinctive phrase, e.g. "banana protocol", at a noted second while `tail -f` the JSONL. Note how long until the line appears. Do it 5 times, once mid-sentence. Record: ______

## Gate (from the brief)

| Check | Pass |
|---|---|
| Transcript lag | under about 2s after the speaker finishes |
| Stream starts by itself | 9 of 10 starts, no clicks |
| Speaker labels | David and the other person distinguishable |
| Final vs partial lines | note whether lines arrive as partials that get revised; the cue engine must only trigger on finalised lines |
| Credits | cost per call-hour acceptable |

If lag fails: switch the ingest to RTMS audio + Deepgram (UK/EU region). Record findings in docs/PHASE0-RESULTS.md.

## Unknowns this spike exists to answer
- Whether `@zoom/rtms` joins on the webhook payload as-is (written to the documented API; not run against live Zoom yet).
- Whether the transcript callback's `timestamp` is wall-clock ms or stream-relative.
- Whether RTMS transcript arrives as partials or finals.
- Real credit cost and whether RTMS access needs a request.
