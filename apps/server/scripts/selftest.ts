/** Offline checks for the engine rules. Run: npx tsx scripts/selftest.ts (exit code 1 on failure). */
import assert from 'node:assert/strict';
import { buildBundle } from '../src/playbooks/supabase.js';
import { headingsOf } from '../src/playbooks/html.js';
import { CoachSession, refExists, type SessionEvent } from '../src/engine/session.js';
import { systemBlocks } from '../src/engine/prompt.js';
import type { CueModel, ModelCall } from '../src/engine/model.js';

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log('ok  ', name);
  } catch (e) {
    failures++;
    console.log('FAIL', name, '-', (e as Error).message);
  }
};

const bundle = buildBundle({ callId: null, label: 't', business: 'A small plumbing firm', callNotes: null, playbook: null, research: null });
const { grounding } = systemBlocks(bundle, 'David Bevan');
const heads = headingsOf(grounding);

/** Records every model call and returns a canned reply. */
function fakeModel(reply: object): CueModel & { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  return { id: 'fake', calls, async complete(c) { calls.push(c); return { text: JSON.stringify(reply), model: 'fake', latencyMs: 1, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }; } };
}
const none = { type: 'none', headline: '', say_this: '', why: '', playbook_ref: '', confidence: 0 };

function session(cue: CueModel, clock: { t: number }, events: SessionEvent[] = []) {
  return new CoachSession(bundle, { cueModel: cue, stateModel: fakeModel({ stage: 'x', covered: [], missing: [], top_gaps: [] }), hostName: 'David Bevan', cueRate: 'proactive', now: () => clock.t, onEvent: (e) => events.push(e) });
}

await check('grounding includes pitfalls and the SME framework', () => {
  assert.ok(heads.includes('Pitfall: talking too long'));
  assert.ok(heads.some((h) => h.startsWith('Q4. The number')));
});

await check('refExists accepts real headings, loose numbering, rejects inventions', () => {
  assert.ok(refExists('Q4. The number (this is the one)', heads));
  assert.ok(refExists('The number (this is the one)', heads));
  assert.ok(refExists('Pitfall: letting a vague answer pass', heads));
  assert.ok(!refExists('Our 30-day money-back guarantee', heads));
  assert.ok(!refExists('', heads));
  for (const bad of ['the', 'Say', 'budget', 'Closing technique: assumptive close']) assert.ok(!refExists(bad, heads), bad);
});

await check('murmurs from the prospect do not reset David\'s talking run', async () => {
  const m = fakeModel(none), clock = { t: 0 };
  const s = session(m, clock);
  const chunk = 'So what we do is we sit down with each person in the team and we map their week out properly';
  let fired: Promise<void> | null = null;
  for (let i = 0; i < 10 && !fired; i++) {
    clock.t += 8000; fired = s.addUtterance('David Bevan', chunk);
    if (!fired) { clock.t += 1000; s.addUtterance('Sam', 'Yeah.'); }
  }
  assert.ok(fired, 'monologue should fire despite murmurs'); await fired;
});

await check('short prospect turns do not trigger; long ones do; cooldown holds', async () => {
  const m = fakeModel(none), clock = { t: 0 };
  const s = session(m, clock);
  clock.t = 1000; assert.equal(s.addUtterance('Sam', 'Yeah fine'), null);
  clock.t = 2000; const p = s.addUtterance('Sam', 'The quoting eats most of my evenings every single week');
  assert.ok(p); await p;
  clock.t = 4000; assert.equal(s.addUtterance('Sam', 'And the timesheets come in on paper every Friday afternoon'), null, 'inside cooldown');
  clock.t = 9000; assert.ok(s.addUtterance('Sam', 'Chasing payment is the other one that drags on and on'));
});

await check('keyword fires inside the cooldown after the keyword gap', async () => {
  const m = fakeModel(none), clock = { t: 0 };
  const s = session(m, clock);
  clock.t = 1000; await s.addUtterance('Sam', 'The quoting eats most of my evenings every single week');
  clock.t = 5500; const p = s.addUtterance('Sam', 'What would it cost?');
  assert.ok(p, 'keyword should fire'); await p;
});

await check('David talking for over a minute triggers a monologue check', async () => {
  const m = fakeModel(none), clock = { t: 0 };
  const s = session(m, clock);
  const long = 'So what we do is we sit down with each person in the team and we map out the week '.repeat(4);
  let fired: Promise<void> | null = null;
  for (let i = 0; i < 3 && !fired; i++) { clock.t += 20_000; fired = s.addUtterance('David Bevan', long); }
  assert.ok(fired, 'monologue should fire'); await fired;
  assert.match(m.calls.at(-1)!.user, /DAVID has been talking/);
});

await check('cue citing a made-up heading is dropped', async () => {
  const events: SessionEvent[] = [];
  const m = fakeModel({ type: 'probe', headline: 'Offer the guarantee', say_this: 'We give your money back if you are not happy.', why: 'Builds trust', playbook_ref: 'Money-back guarantee', confidence: 0.9 });
  const clock = { t: 0 }; const s = session(m, clock, events);
  clock.t = 1000; await s.addUtterance('Sam', 'I am not sure this is worth the money for us right now honestly');
  assert.equal(s.cues.length, 0);
  assert.ok(events.some((e) => e.kind === 'eval' && e.outcome === 'no_ref'));
});

await check('low-confidence and over-long cues are dropped; a good one is shown', async () => {
  const clock = { t: 0 };
  const low = session(fakeModel({ type: 'probe', headline: 'Ask hours', say_this: 'How many hours?', why: 'gap', playbook_ref: 'Q4. The number (this is the one)', confidence: 0.3 }), clock);
  clock.t = 1000; await low.addUtterance('Sam', 'The quoting eats most of my evenings every single week');
  assert.equal(low.cues.length, 0);
  const wordy = session(fakeModel({ type: 'probe', headline: 'Ask hours', say_this: Array(40).fill('word').join(' '), why: 'gap', playbook_ref: 'Q4. The number (this is the one)', confidence: 0.9 }), clock);
  clock.t = 2000; await wordy.addUtterance('Sam', 'The quoting eats most of my evenings every single week');
  assert.equal(wordy.cues.length, 0);
  const good = session(fakeModel({ type: 'probe', headline: 'Pin the number down', say_this: 'Roughly how many hours a week does that eat, and whose desk is it on?', why: 'No number yet', playbook_ref: 'Pitfall: letting a vague answer pass', confidence: 0.8 }), clock);
  clock.t = 3000; await good.addUtterance('Sam', 'The quoting eats most of my evenings every single week');
  assert.equal(good.cues.length, 1);
});

await check('the prospect playbook outranks the framework in the prompt', () => {
  const b = buildBundle({ callId: 'x', label: 'x', business: 'x', callNotes: null, playbook: { title: 'Call playbook', html: '<h2>Open</h2><p>Hi</p>', createdAt: '2026-11-01T00:00:00Z' }, research: null });
  const g = systemBlocks(b, 'David Bevan').grounding;
  assert.match(g, /PROSPECT PLAYBOOK \(Layer 2\).*this wins/);
  assert.equal(b.sector, null);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
