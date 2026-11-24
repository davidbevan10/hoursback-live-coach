// Checks the coach can be set up before a Zoom call: booking list, booking, type and stage.
import assert from 'node:assert/strict';
import { buildApp } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { StubModel } from '../src/engine/model.js';
import type { PlaybookSource } from '../src/playbooks/source.js';

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const playbooks: PlaybookSource & { recent: () => Promise<any[]> } = {
  candidatesNear: async () => [{ id: ID_B, label: 'Nearest booking', scheduledAt: null, hasPlaybook: true }],
  recent: async () => [{ id: ID_A, label: 'Jane Doe - Acme', scheduledAt: null, hasPlaybook: true }],
  load: async (id) => ({ callId: id, label: id === ID_A ? 'Jane Doe - Acme' : 'Nearest booking', callType: 'sme_discovery', stage: 'first', prospectPlaybook: null, prospectContext: '', sector: null, warnings: [] }),
};
const source = { start: async () => {}, stop: async () => {}, on: () => {} } as any;
const app = buildApp({ source, playbooks, models: { cue: new StubModel(), state: new StubModel() }, config: { ...loadConfig(), coachToken: 'tok', zoomWebhookSecret: '' } as any });
const h = { cookie: 'coach_key=tok', 'content-type': 'application/json' };

// 1. Booking list works with no call.
const calls = await app.inject({ method: 'GET', url: '/api/calls', headers: h });
assert.equal(calls.statusCode, 200);
assert.equal(calls.json()[0].label, 'Jane Doe - Acme');

// 2. Picking a booking, type and stage with no call keeps them for the next call.
let r = await app.inject({ method: 'POST', url: '/api/call', headers: h, payload: { callId: ID_A } });
assert.equal(r.json().mode, 'next_call');
await app.inject({ method: 'POST', url: '/api/call', headers: h, payload: { callType: 'other' } });
await app.inject({ method: 'POST', url: '/api/call', headers: h, payload: { stage: 'follow_up' } });
assert.deepEqual(app.hub.snapshot().prep, { callId: ID_A, callType: 'other', stage: 'follow_up' });

// 3. The call starts and uses them, not the nearest booking.
await app.hub.start('stream-1', 'meeting-1');
const b = app.hub.snapshot().session!.bundle as any;
assert.equal(b.callId, ID_A);
assert.equal(b.callType, 'other');
assert.equal(b.stage, 'follow_up');
assert.equal(app.hub.snapshot().prep, null);

// 4. During the call, changes apply straight away.
r = await app.inject({ method: 'POST', url: '/api/call', headers: h, payload: { stage: 'first' } });
assert.equal(r.json().mode, 'live');
assert.equal((app.hub.snapshot().session!.bundle as any).stage, 'first');

// 5. "None" before a call means generic framework, not the nearest booking.
app.hub.end('stream-1');
await app.inject({ method: 'POST', url: '/api/call', headers: h, payload: { callId: null } });
await app.hub.start('stream-2', 'meeting-2');
assert.equal((app.hub.snapshot().session!.bundle as any).callId, null);

// 6. With nothing picked, the nearest booking is used as before.
app.hub.end('stream-2');
await app.hub.start('stream-3', 'meeting-3');
assert.equal((app.hub.snapshot().session!.bundle as any).callId, ID_B);

console.log('prepcheck: all pass');
process.exit(0);
