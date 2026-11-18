import { CUE_RATES, type CueRate } from '../config.js';
import { headingsOf } from '../playbooks/html.js';
import { layer1Text, type PlaybookBundle } from '../playbooks/source.js';
import type { CueModel } from './model.js';
import { cueUserMessage, stateUserMessage, systemBlocks, type Turn } from './prompt.js';
import { CueSchema, StateSchema, extractJson, type CallState, type Cue } from './schema.js';

export type ShownCue = Cue & {
  id: string;
  at: number;
  model: string;
  latencyMs: number;
  triggeredBy: 'turn' | 'keyword';
  cueRate: CueRate;
  playbookVersion: string | null;
};

export type SessionEvent =
  | { kind: 'turn'; turn: Turn }
  | { kind: 'cue'; cue: ShownCue }
  | { kind: 'state'; state: CallState }
  | { kind: 'eval'; at: number; outcome: 'none' | 'below_threshold' | 'invalid' | 'no_ref' | 'shown' | 'error'; detail?: string; latencyMs?: number; triggeredBy: 'turn' | 'keyword' }
  | { kind: 'bundle'; bundle: Pick<PlaybookBundle, 'callId' | 'label' | 'callType' | 'sector' | 'warnings'> & { playbookTitle: string | null } };

/** Words that justify evaluating early, inside the cooldown (brief, section 5). */
const KEYWORDS = /\b(price|pricing|cost|costs|budget|expensive|afford|how much|already use|already have|we use|not sure|need to (talk|speak|check) (to|with)|run it by|sign[- ]off|board|competitor|in-house|it team|send me|next steps?|timeline|too busy)\b/i;

const WINDOW_MS = 90_000;
const MIN_PROSPECT_WORDS = 6;
const STATE_EVERY_MS = 45_000;

export interface SessionDeps {
  cueModel: CueModel;
  stateModel: CueModel;
  hostName: string;
  cueRate: CueRate;
  now?: () => number;
  /** In replay the harness awaits each evaluation so timings stay deterministic. */
  onEvent: (e: SessionEvent) => void;
}

export class CoachSession {
  readonly turns: Turn[] = [];
  readonly cues: ShownCue[] = [];
  state: CallState | null = null;
  bundle: PlaybookBundle;
  cueRate: CueRate;
  private startedAt: number;
  private lastEvalAt = -Infinity;
  private lastStateAt = -Infinity;
  private evalInFlight: Promise<void> | null = null;
  private stateInFlight: Promise<void> | null = null;
  private lastSpeaker: string | null = null;
  private blocks: { rules: string; grounding: string };
  private headings: string[];
  private seq = 0;

  constructor(bundle: PlaybookBundle, private deps: SessionDeps) {
    this.cueRate = deps.cueRate;
    this.startedAt = this.now();
    this.bundle = bundle;
    this.blocks = systemBlocks(bundle, deps.hostName);
    this.headings = headingsOf(this.blocks.grounding);
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Swap the grounding mid-call (David picked a different booking or call type on the page). */
  setBundle(bundle: PlaybookBundle) {
    this.bundle = bundle;
    this.blocks = systemBlocks(bundle, this.deps.hostName);
    this.headings = headingsOf(this.blocks.grounding);
    this.deps.onEvent({ kind: 'bundle', bundle: summary(bundle) });
  }

  setCueRate(rate: CueRate) {
    this.cueRate = rate;
  }

  noteActiveSpeaker(name: string) {
    this.lastSpeaker = name;
  }

  /** Feed one finalised utterance. Returns the evaluation promise if one was started (replay awaits it). */
  addUtterance(speaker: string, text: string): Promise<void> | null {
    const name = speaker && speaker !== 'unknown' ? speaker : (this.lastSpeaker ?? 'unknown');
    const role: Turn['role'] = sameName(name, this.deps.hostName) ? 'host' : 'prospect';
    const turn: Turn = { speaker: name, role, text: text.trim(), at: this.now() };
    if (!turn.text) return null;
    this.turns.push(turn);
    this.deps.onEvent({ kind: 'turn', turn });

    const now = turn.at;
    let started: Promise<void> | null = null;

    if (now - this.lastStateAt >= STATE_EVERY_MS && !this.stateInFlight) {
      this.lastStateAt = now;
      this.stateInFlight = this.updateState().finally(() => (this.stateInFlight = null));
    }

    if (role !== 'prospect') return null;
    const words = turn.text.split(/\s+/).length;
    const keyword = KEYWORDS.test(turn.text);
    if (words < MIN_PROSPECT_WORDS && !keyword) return null;

    const r = CUE_RATES[this.cueRate];
    const since = now - this.lastEvalAt;
    const due = since >= r.cooldownMs || (keyword && since >= r.keywordGapMs);
    if (!due || this.evalInFlight) return null;

    this.lastEvalAt = now;
    started = this.evaluate(keyword && since < r.cooldownMs ? 'keyword' : 'turn').finally(() => (this.evalInFlight = null));
    this.evalInFlight = started;
    return started;
  }

  /** Wait for any in-flight model calls (used by replay and on session stop). */
  async settle() {
    await Promise.all([this.evalInFlight, this.stateInFlight]);
  }

  private window(): Turn[] {
    const cutoff = this.now() - WINDOW_MS;
    const recent = this.turns.filter((t) => t.at >= cutoff);
    return recent.length >= 4 ? recent : this.turns.slice(-4);
  }

  private async evaluate(triggeredBy: 'turn' | 'keyword') {
    const at = this.now();
    try {
      const res = await this.deps.cueModel.complete({
        ...this.blocks,
        user: cueUserMessage({ turns: this.window(), state: this.state, recentCues: this.cues.slice(-3), elapsedMin: (at - this.startedAt) / 60_000 }),
        maxTokens: 300,
      });
      const parsed = CueSchema.safeParse(extractJson(res.text));
      if (!parsed.success) {
        this.deps.onEvent({ kind: 'eval', at, outcome: 'invalid', detail: parsed.error.issues.map((i) => i.message).join('; '), latencyMs: res.latencyMs, triggeredBy });
        return;
      }
      const cue = parsed.data;
      if (cue.type === 'none') {
        this.deps.onEvent({ kind: 'eval', at, outcome: 'none', latencyMs: res.latencyMs, triggeredBy });
        return;
      }
      if (cue.confidence < CUE_RATES[this.cueRate].minConfidence) {
        this.deps.onEvent({ kind: 'eval', at, outcome: 'below_threshold', detail: `${cue.confidence} ${cue.headline}`, latencyMs: res.latencyMs, triggeredBy });
        return;
      }
      if (!refExists(cue.playbook_ref, this.headings)) {
        this.deps.onEvent({ kind: 'eval', at, outcome: 'no_ref', detail: cue.playbook_ref, latencyMs: res.latencyMs, triggeredBy });
        return;
      }
      const shown: ShownCue = {
        ...cue,
        id: `c${++this.seq}`,
        at: this.now(),
        model: res.model,
        latencyMs: res.latencyMs,
        triggeredBy,
        cueRate: this.cueRate,
        playbookVersion: this.bundle.prospectPlaybook ? `${this.bundle.prospectPlaybook.title} @ ${this.bundle.prospectPlaybook.createdAt}` : null,
      };
      this.cues.push(shown);
      this.deps.onEvent({ kind: 'eval', at, outcome: 'shown', latencyMs: res.latencyMs, triggeredBy });
      this.deps.onEvent({ kind: 'cue', cue: shown });
    } catch (err) {
      this.deps.onEvent({ kind: 'eval', at, outcome: 'error', detail: String(err), triggeredBy });
    }
  }

  private async updateState() {
    try {
      const res = await this.deps.stateModel.complete({
        ...this.blocks,
        user: stateUserMessage({ turns: this.turns.slice(-200), previous: this.state, elapsedMin: (this.now() - this.startedAt) / 60_000 }),
        maxTokens: 500,
      });
      const parsed = StateSchema.safeParse(extractJson(res.text));
      if (parsed.success) {
        this.state = parsed.data;
        this.deps.onEvent({ kind: 'state', state: parsed.data });
      }
    } catch {
      // The checklist is a nice-to-have; a failed update just keeps the previous one.
    }
  }
}

export function summary(b: PlaybookBundle) {
  return { callId: b.callId, label: b.label, callType: b.callType, sector: b.sector, warnings: b.warnings, playbookTitle: b.prospectPlaybook?.title ?? null };
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sameName(a: string, b: string) {
  const x = norm(a), y = norm(b);
  return x === y || (y.length > 0 && x.startsWith(y.split(' ')[0]) && x.includes(y.split(' ').slice(-1)[0]));
}

/** The model must cite a real heading. Loose match: models trim numbering or punctuation. */
export function refExists(ref: string, headings: string[]): boolean {
  const r = norm(ref.replace(/^(layer \d|prospect playbook|generic framework)\s*[:>-]\s*/i, ''));
  if (!r) return false;
  const rt = new Set(r.split(' '));
  return headings.some((h) => {
    const n = norm(h);
    if (!n) return false;
    if (n.includes(r) || r.includes(n)) return true;
    const ht = n.split(' ');
    const overlap = ht.filter((w) => rt.has(w)).length;
    return overlap / Math.max(ht.length, 1) >= 0.6 && overlap >= 2;
  });
}

export { layer1Text };
