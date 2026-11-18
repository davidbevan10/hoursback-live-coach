/**
 * Local demo of the whole loop with no Zoom: starts the server with a fake transcript source,
 * fires a signed rtms_started webhook, and streams the fictional demo call at speaking speed.
 *   COACH_TOKEN=dev npx tsx scripts/demo.ts   then open http://localhost:8080/?key=dev
 * Uses Claude if ANTHROPIC_API_KEY is set, otherwise the stub model.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import type { TranscriptSource } from '../src/sources/types.js';

process.env.ZOOM_WEBHOOK_SECRET_TOKEN ||= 'demo-secret';
process.env.COACH_TOKEN ||= 'dev';
const cfg = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const demo = JSON.parse(fs.readFileSync(path.resolve(here, '../../../eval/fixtures/demo-call.json'), 'utf8'));
const lines: { speaker: string; text: string }[] = demo.transcript.split('\n').map((l: string) => {
  const i = l.indexOf(':');
  return { speaker: l.slice(0, i), text: l.slice(i + 1).trim() };
});
const speed = Number(process.env.DEMO_SPEED ?? 1);

const fake: TranscriptSource = {
  start(_p, emit) {
    let t = 1500;
    for (const l of lines) {
      t += ((l.text.split(/\s+/).length / 2.5) * 1000 + 400) / speed;
      setTimeout(() => emit({ kind: 'transcript', speaker: l.speaker, speakerId: null, text: l.text, sourceTs: Date.now() }), t);
    }
  },
  stop() {},
};

const app = buildApp({ source: fake, config: cfg, playbooks: null });
await app.listen({ port: cfg.port, host: '0.0.0.0' });
const body = JSON.stringify({ event: 'meeting.rtms_started', payload: { meeting_uuid: 'demo==', rtms_stream_id: 'demo-stream' } });
const ts = String(Math.floor(Date.now() / 1000));
const sig = 'v0=' + crypto.createHmac('sha256', cfg.zoomSecret).update(`v0:${ts}:${body}`).digest('hex');
await app.inject({ method: 'POST', url: '/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': ts, 'x-zm-signature': sig } });
console.log(`Demo running: http://localhost:${cfg.port}/?key=${cfg.coachToken}`);
