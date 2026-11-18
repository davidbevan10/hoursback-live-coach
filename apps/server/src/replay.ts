import type { CueRate } from './config.js';
import type { CueModel } from './engine/model.js';
import { CoachSession, type SessionEvent, type ShownCue } from './engine/session.js';
import type { CallType } from './playbooks/source.js';
import { buildBundle, type RawCallMaterial } from './playbooks/supabase.js';
import pg from 'pg';

export interface ReplayInput extends RawCallMaterial {
  transcript: string;
}

/** Load a past call for replay. call_notes are left out: they are written during and after the call and would leak the outcome. */
export async function loadReplayInput(callId: string, databaseUrl: string): Promise<ReplayInput> {
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const c = (await pool.query(`select id, business, display_name, transcript from prospect_calls where id = $1`, [callId])).rows[0];
    if (!c?.transcript) throw new Error('No transcript on that call');
    const pb = (await pool.query(`select title, content_html, created_at from prospect_documents where prospect_call_id=$1 and kind='playbook' and content_html is not null order by created_at desc limit 1`, [callId])).rows[0];
    const rs = (await pool.query(`select title, content_html from prospect_documents where prospect_call_id=$1 and kind='research' and content_html is not null order by created_at desc limit 1`, [callId])).rows[0];
    return {
      callId,
      label: c.display_name ?? (c.business ?? 'call').slice(0, 40),
      business: c.business,
      callNotes: null,
      playbook: pb ? { title: pb.title, html: pb.content_html, createdAt: pb.created_at.toISOString() } : null,
      research: rs ? { title: rs.title, html: rs.content_html } : null,
      transcript: c.transcript,
    };
  } finally {
    await pool.end();
  }
}

/** "Name: text" per line, the format Zoom transcripts are stored in on prospect_calls. */
export function parseTranscript(t: string) {
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

const mm = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

/** Play a past call through the real engine at simulated speaking speed. */
export async function runReplay(input: ReplayInput, opts: { cueModel: CueModel; stateModel: CueModel; hostName: string; rate: CueRate; callType?: CallType }) {
  const bundle = buildBundle(input);
  if (opts.callType) bundle.callType = opts.callType;
  let clock = 0;
  const evals: Extract<SessionEvent, { kind: 'eval' }>[] = [];
  const session = new CoachSession(bundle, {
    cueModel: opts.cueModel,
    stateModel: opts.stateModel,
    hostName: opts.hostName,
    cueRate: opts.rate,
    now: () => clock,
    onEvent: (e) => {
      if (e.kind === 'eval') evals.push(e);
    },
  });
  const lines = parseTranscript(input.transcript);
  const t0 = Date.now();
  for (const l of lines) {
    clock += (l.text.split(/\s+/).length / 2.5) * 1000 + 400; // about 2.5 words a second
    const p = session.addUtterance(l.speaker, l.text);
    if (p) await p;
  }
  await session.settle();

  const lat = evals.filter((e) => e.latencyMs != null).map((e) => e.latencyMs!);
  const count = (o: string) => evals.filter((e) => e.outcome === o).length;
  const summary = {
    label: input.label,
    callId: input.callId,
    model: opts.cueModel.id,
    cueRate: opts.rate,
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

  const md = [
    `# Replay: ${input.label}`,
    '',
    `Model ${summary.model}, cue rate ${summary.cueRate}, call type ${summary.callType}. Playbook: ${summary.playbook ?? 'none'}${summary.sector ? ` (sector fallback: ${summary.sector})` : ''}.`,
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
        `Why: ${c.why}. Ref: ${c.playbook_ref}. Confidence ${c.confidence}, ${c.latencyMs} ms, trigger ${c.triggeredBy}.`,
        `Context: ${session.turns.filter((t) => t.at <= c.at).slice(-2).map((t) => `${t.role === 'host' ? 'David' : 'Prospect'}: "${t.text.slice(0, 160)}"`).join(' / ')}`,
        'Label: ',
        '',
      ].join('\n'),
    ),
    '## Final coverage state',
    session.state ? `Stage ${session.state.stage}. Missing: ${session.state.missing.join('; ')}` : 'none',
  ].join('\n');

  return { summary, cues: session.cues, evals, finalState: session.state, markdown: md };
}
