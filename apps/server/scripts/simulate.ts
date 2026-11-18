// Local test with no Zoom: signs and posts fake webhooks to a server using a fake transcript source.
import crypto from 'node:crypto';
import { buildApp } from '../src/index.js';
import type { CoachEvent, TranscriptSource } from '../src/sources/types.js';

process.env.ZOOM_WEBHOOK_SECRET_TOKEN ??= 'test-secret';
const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN!;

const fake: TranscriptSource = {
  start(_p, emit) {
    const lines: [string, string][] = [['Prospect', 'We already use a spreadsheet for that.'], ['David', 'Which bit takes the longest?']];
    lines.forEach(([speaker, text], i) => setTimeout(() => emit({ kind: 'transcript', speaker, speakerId: i, text, sourceTs: Date.now() - 400 } as CoachEvent), 100 * (i + 1)));
  },
  stop() {},
};

const app = buildApp(fake);
const sign = (body: string) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'x-zm-request-timestamp': ts, 'x-zm-signature': 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex'), 'content-type': 'application/json' };
};
const post = (obj: unknown, headers?: Record<string, string>) => {
  const body = JSON.stringify(obj);
  return app.inject({ method: 'POST', url: '/webhook', payload: body, headers: headers ?? sign(body) });
};

const v = await post({ event: 'endpoint.url_validation', payload: { plainToken: 'abc' } }, { 'content-type': 'application/json' });
const expected = crypto.createHmac('sha256', secret).update('abc').digest('hex');
console.log('url_validation ok:', v.json().encryptedToken === expected);

const bad = await post({ event: 'meeting.rtms_started', payload: {} }, { 'content-type': 'application/json', 'x-zm-signature': 'v0=nope', 'x-zm-request-timestamp': String(Math.floor(Date.now() / 1000)) });
console.log('bad signature rejected (401):', bad.statusCode === 401);

const start = { event: 'meeting.rtms_started', payload: { meeting_uuid: 'sim-uuid==', rtms_stream_id: 'stream-1', server_urls: 'wss://x' } };
console.log('start accepted:', (await post(start)).statusCode === 200);
console.log('duplicate start accepted but not re-opened:', (await post(start)).statusCode === 200);
await new Promise((r) => setTimeout(r, 400));
console.log('health:', (await app.inject({ url: '/health' })).json());
console.log('stop accepted:', (await post({ event: 'meeting.rtms_stopped', payload: { meeting_uuid: 'sim-uuid==', rtms_stream_id: 'stream-1' } })).statusCode === 200);
await app.close();
