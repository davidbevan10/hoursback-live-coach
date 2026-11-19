import type { Config, CueRate } from './config.js';
import { openSessionLog } from './logger.js';
import type { CueModel } from './engine/model.js';
import { CoachSession, summary, type SessionEvent } from './engine/session.js';
import type { CallCandidate, CallType, PlaybookBundle, PlaybookSource } from './playbooks/source.js';
import type { CoachEvent } from './sources/types.js';

type Listener = (event: string, data: unknown) => void;

interface Live {
  streamId: string;
  meetingUuid: string;
  startedAt: number;
  session: CoachSession;
  candidates: CallCandidate[];
  log: ReturnType<typeof openSessionLog>;
  feedback: Record<string, string>;
  stats: Record<string, number>;
  ended: boolean;
}

const EMPTY_BUNDLE = (callType: CallType = 'sme_discovery'): PlaybookBundle => ({
  callId: null,
  label: 'No booking matched',
  callType,
  prospectPlaybook: null,
  prospectContext: '',
  sector: null,
  warnings: ['No booking matched this call - cues use the generic framework only. Pick the booking on the page.'],
});

/**
 * Owns every live coaching session and fans its events out to the coach page(s).
 * One Zoom stream = one session. The page follows the most recent session.
 */
export class Hub {
  private sessions = new Map<string, Live>();
  private listeners = new Set<Listener>();
  private currentId: string | null = null;

  constructor(
    private cfg: Config,
    private models: { cue: CueModel; state: CueModel },
    private playbooks: PlaybookSource | null,
  ) {}

  get activeCount() {
    return [...this.sessions.values()].filter((s) => !s.ended).length;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn('snapshot', this.snapshot());
    return () => this.listeners.delete(fn);
  }

  private broadcast(event: string, data: unknown) {
    for (const fn of this.listeners) fn(event, data);
  }

  current(): Live | null {
    return this.currentId ? (this.sessions.get(this.currentId) ?? null) : null;
  }

  snapshot() {
    const s = this.current();
    if (!s) return { session: null, cueRate: this.cfg.cueRate };
    return {
      session: {
        streamId: s.streamId,
        startedAt: s.startedAt,
        ended: s.ended,
        bundle: summary(s.session.bundle),
        candidates: s.candidates,
        turns: s.session.turns.slice(-40),
        cues: s.session.cues.slice(-10),
        state: s.session.state,
        feedback: s.feedback,
        cueModel: this.models.cue.id,
      },
      cueRate: s.session.cueRate,
    };
  }

  /** Called from the Zoom source. Sets up the session on session_start, feeds it afterwards. */
  handle(streamId: string, e: CoachEvent) {
    if (e.kind === 'session_start') return; // the webhook handler starts the session
    const live = this.sessions.get(streamId);
    if (!live) return;
    live.log.write(e);
    if (e.kind === 'transcript') {
      // Zoom sometimes opens two streams for one meeting. The page follows whichever one is
      // actually carrying the transcript.
      if (this.currentId !== streamId) {
        this.currentId = streamId;
        this.broadcast('snapshot', this.snapshot());
      }
      live.session.addUtterance(e.speaker, e.text);
    }
    if (e.kind === 'active_speaker') live.session.noteActiveSpeaker(e.speaker);
    if (e.kind === 'session_stop' || e.kind === 'leave') this.end(streamId);
  }

  async start(streamId: string, meetingUuid: string, bundleOverride?: PlaybookBundle) {
    if (this.sessions.has(streamId)) return;
    const startedAt = Date.now();
    const log = openSessionLog(this.cfg.dataDir, meetingUuid);
    // The session exists straight away so no early utterance is lost; the playbook loads in behind it.
    const bundle =
      bundleOverride ??
      (this.playbooks
        ? { ...EMPTY_BUNDLE(), warnings: ['Loading the playbook for this booking...'] }
        : { ...EMPTY_BUNDLE(), warnings: ['Playbook database not connected (HOURSBACK_DB_URL not set) - generic framework only.'] });

    const live: Live = {
      streamId,
      meetingUuid,
      startedAt,
      candidates: [],
      log,
      feedback: {},
      stats: {},
      ended: false,
      session: new CoachSession(bundle, {
        cueModel: this.models.cue,
        stateModel: this.models.state,
        hostName: this.cfg.hostName,
        cueRate: this.cfg.cueRate,
        onEvent: (ev) => this.onSessionEvent(streamId, ev),
      }),
    };
    this.sessions.set(streamId, live);
    this.currentId = streamId;
    log.write({ kind: 'coach_start', cueRate: this.cfg.cueRate, cueModel: this.models.cue.id, stateModel: this.models.state.id });
    this.broadcast('snapshot', this.snapshot());

    if (!bundleOverride && this.playbooks) {
      let loaded: PlaybookBundle;
      try {
        live.candidates = await this.playbooks.candidatesNear(new Date(startedAt));
        loaded = live.candidates[0] ? await this.playbooks.load(live.candidates[0].id) : EMPTY_BUNDLE();
      } catch (err) {
        loaded = { ...EMPTY_BUNDLE(), warnings: [`Could not load playbooks: ${String(err).slice(0, 140)}`] };
      }
      live.session.setBundle(loaded);
      log.write({ kind: 'coach_bundle', bundle: summary(loaded), candidates: live.candidates });
      this.broadcast('snapshot', this.snapshot());
    }
  }

  private onSessionEvent(streamId: string, ev: SessionEvent) {
    const live = this.sessions.get(streamId);
    if (!live) return;
    if (ev.kind !== 'turn') live.log.write({ ...ev, kind: `coach_${ev.kind}` });
    live.stats[ev.kind === 'eval' ? `eval_${ev.outcome}` : ev.kind] = (live.stats[ev.kind === 'eval' ? `eval_${ev.outcome}` : ev.kind] ?? 0) + 1;
    // Operational trace for the Railway logs: outcomes and timings only, never what anyone said.
    if (ev.kind === 'eval') console.log(JSON.stringify({ msg: 'COACH EVAL', streamId, outcome: ev.outcome, trigger: ev.triggeredBy, latencyMs: ev.latencyMs, detail: ev.outcome === 'error' || ev.outcome === 'invalid' ? ev.detail?.slice(0, 200) : undefined }));
    if (streamId === this.currentId) this.broadcast(ev.kind, ev);
  }

  end(streamId: string) {
    const live = this.sessions.get(streamId);
    if (!live || live.ended) return;
    live.ended = true;
    void live.session.settle().finally(() => {
      live.log.write({ kind: 'coach_end', cues: live.session.cues.length, feedback: live.feedback });
      console.log(JSON.stringify({ msg: 'COACH SESSION END', streamId, minutes: +((Date.now() - live.startedAt) / 60000).toFixed(1), stats: live.stats, feedback: Object.values(live.feedback), bundle: live.session.bundle.callId ? 'booking' : 'none' }));
      live.log.close();
    });
    if (streamId === this.currentId) this.broadcast('ended', { streamId });
    // Keep ended sessions for an hour so the page can still show the last call.
    setTimeout(() => this.sessions.delete(streamId), 60 * 60_000).unref();
  }

  feedback(cueId: string, label: string) {
    const live = this.current();
    if (!live) return false;
    live.feedback[cueId] = label;
    live.log.write({ kind: 'cue_feedback', cueId, label });
    this.broadcast('feedback', { cueId, label });
    return true;
  }

  setCueRate(rate: CueRate) {
    const live = this.current();
    if (!live) return false;
    live.session.setCueRate(rate);
    live.log.write({ kind: 'cue_rate', rate });
    this.broadcast('snapshot', this.snapshot());
    return true;
  }

  /** callId undefined = keep the booking; null = "None" picked (generic framework only). */
  async pickCall(callId: string | null | undefined, callType?: CallType) {
    const live = this.current();
    if (!live) return false;
    let bundle = live.session.bundle;
    if (callId === null) bundle = EMPTY_BUNDLE(callType ?? bundle.callType);
    else if (callId && this.playbooks) bundle = await this.playbooks.load(callId);
    if (callType) bundle = { ...bundle, callType };
    live.session.setBundle(bundle);
    live.log.write({ kind: 'call_picked', callId, callType: bundle.callType });
    this.broadcast('snapshot', this.snapshot());
    return true;
  }

  async recentCalls(): Promise<CallCandidate[]> {
    const src = this.playbooks as (PlaybookSource & { recent?: () => Promise<CallCandidate[]> }) | null;
    return src?.recent ? src.recent() : [];
  }
}
