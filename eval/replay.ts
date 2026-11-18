/**
 * Replay harness (Phase 1). Plays a past call's transcript through the real cue engine at
 * simulated speaking speed and writes a report of every cue it would have shown.
 *
 *   npx tsx eval/replay.ts --call <prospect_calls id>     (needs HOURSBACK_DB_URL)
 *   npx tsx eval/replay.ts --file eval/gold/<name>.json   (offline file, see eval/README.md)
 *   add --model claude-sonnet-5-5 to override CUE_MODEL; --rate balanced to override CUE_RATE
 *
 * Needs ANTHROPIC_API_KEY for real cues; without it the stub model runs (pipeline check only).
 * Output: eval/out/<label>-<model>-<rate>.md and .json. eval/out and eval/gold are gitignored
 * (prospect data).
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadConfig, type CueRate } from '../apps/server/src/config.js';
import { AnthropicModel, StubModel } from '../apps/server/src/engine/model.js';
import { CoachSession, type SessionEvent, type ShownCue } from '../apps/server/src/engine/session.js';
import { buildBundle, type RawCallMaterial } from '../apps/server/src/playbooks/supabase.js';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface ReplayInput extends RawCallMaterial {
  transcript: string;
}

async function fromDb(callId: string, url: string): Promise<ReplayInput> {
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const c = (await pool.query(`select id, business, display_name, call_notes, transcript from prospect_calls where id = $1`, [callId])).rows[0];
  if (!c?.transcript) throw new Error('No transcript on that call');
  const pb = (await pool.query(`select title, content_html, created_at from prospect_documents where prospect_call_id=$1 and kind='playbook' and content_html is not null order by created_at desc limit 1`, [callId])).rows[0];
  const rs = (await pool.query(`select title, content_html from prospect_documents where prospect_call_id=$1 and kind='research' and content_html is not null order by created_at desc limit 1`, [callId])).rows[0];
  await pool.end();
  return {
    callId,
    label: c.display_name ?? (c.business ?? 'call').slice(0, 40),
    business: c.business,
    // call_notes are written during and after the call too, so they would leak the outcome. Replay leaves them out.
    callNotes: null,
    playbook: pb ? { title: pb.title, html: pb.content_html, createdAt: pb.created_at.toISOString() } : null,
    research: rs ? { title: rs.title, html: rs.content_html } : null,
    transcript: c.transcript,
  };
}

/** "Name: text" per line (the format Zoom transcripts are stored in on prospect_calls). */
function parseTranscript(t: string) {
  return t
    .split('\n')
    .map((l) => /^([^:]{1,60}):\s*(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ speaker: m[1].trim(), text: m[2].trim() }));
}

function pct(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const cfg = loadConfig();
const callId = arg('call');
const file = arg('file');
const input: ReplayInput = callId
  ? await fromDb(callId, cfg.databaseUrl || (() => { throw new Error('HOURSBACK_DB_URL not set'); })())
  : JSON.parse(fs.readFileSync(file ?? (() => { throw new Error('pass --call <id> or --file <path>'); })(), 'utf8'));

const modelId = arg('model') ?? cfg.cueModel;
const rate = (arg('rate') ?? cfg.cueRate) as CueRate;
const cueModel = cfg.anthropicKey ? new AnthropicModel(cfg.anthropicKey, modelId) : new StubModel();
const stateModel = cfg.anthropicKey ? new AnthropicModel(cfg.anthropicKey, cfg.stateModel) : new StubModel();

const bundle = buildBundle(input);
if (arg('calltype')) bundle.callType = arg('calltype') as any;

let clock = 0;
const evals: Extract<SessionEvent, { kind: 'eval' }>[] = [];
const session = new CoachSession(bundle, {
  cueModel,
  stateModel,
  hostName: arg('host') ?? cfg.hostName,
  cueRate: rate,
  now: () => clock,
  onEvent: (e) => {
    if (e.kind === 'eval') evals.push(e);
  },
});

const lines = parseTranscript(input.transcript);
const t0 = Date.now();
for (const l of lines) {
  // Speaking speed about 2.5 words a second, plus a short gap between turns.
  clock += (l.text.split(/\s+/).length / 2.5) * 1000 + 400;
  const p = session.addUtterance(l.speaker, l.text);
  if (p) await p;
}
await session.settle();

const lat = evals.filter((e) => e.latencyMs != null).map((e) => e.latencyMs!);
const count = (o: string) => evals.filter((e) => e.outcome === o).length;
const mm = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const summary = {
  label: input.label,
  callId: input.callId,
  model: cueModel.id,
  cueRate: rate,
  callType: bundle.callType,
  playbook: bundle.prospectPlaybook?.title ?? null,
  sector: bundle.sector,
  turns: lines.length,
  simulatedMinutes: +(clock / 60000).toFixed(1),
  evaluations: evals.length,
  shown: count('shown'),
  none: count('none'),
  belowThreshold: count('below_threshold'),
  invalid: count('invalid'),
  noRef: count('no_ref'),
  errors: count('error'),
  latencyP50: pct(lat, 50),
  latencyP95: pct(lat, 95),
  wallSeconds: Math.round((Date.now() - t0) / 1000),
};

const outDir = path.resolve('eval/out');
fs.mkdirSync(outDir, { recursive: true });
const slug = `${input.label}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + `-${cueModel.id}-${rate}`;
fs.writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify({ summary, cues: session.cues, evals, finalState: session.state }, null, 2));

const md = [
  `# Replay: ${input.label}`,
  '',
  `Model ${summary.model}, cue rate ${rate}, call type ${summary.callType}. Playbook: ${summary.playbook ?? 'none'}${summary.sector ? ` (sector fallback: ${summary.sector})` : ''}.`,
  `${summary.turns} turns, about ${summary.simulatedMinutes} minutes. ${summary.evaluations} evaluations: ${summary.shown} cues shown, ${summary.none} none, ${summary.belowThreshold} below threshold, ${summary.invalid} invalid, ${summary.noRef} without a real playbook reference, ${summary.errors} errors.`,
  `Cue latency p50 ${summary.latencyP50} ms, p95 ${summary.latencyP95} ms.`,
  '',
  '## Cues to label',
  'Mark each one: useful / useless / obvious.',
  '',
  ...session.cues.map((c: ShownCue, i) =>
    [
      `### ${i + 1}. [${mm(c.at)}] ${c.type}: ${c.headline}`,
      `Say: "${c.say_this}"`,
      `Why: ${c.why}. Ref: ${c.playbook_ref}. Confidence ${c.confidence}, ${c.latencyMs} ms.`,
      `Context: ${session.turns.filter((t) => t.at <= c.at).slice(-2).map((t) => `${t.role === 'host' ? 'David' : 'Prospect'}: "${t.text.slice(0, 160)}"`).join(' / ')}`,
      'Label: ',
      '',
    ].join('\n'),
  ),
  '## Final coverage state',
  session.state ? `Stage ${session.state.stage}. Missing: ${session.state.missing.join('; ')}` : 'none',
].join('\n');
fs.writeFileSync(path.join(outDir, `${slug}.md`), md);
console.log(JSON.stringify(summary, null, 2));
console.log(`Report: eval/out/${slug}.md`);
