import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { loadConfig, CUE_RATES, type Config, type CueRate } from './config.js';
import { AnthropicModel, StubModel, type CueModel } from './engine/model.js';
import { Hub } from './hub.js';
import { SupabasePlaybookSource } from './playbooks/supabase.js';
import type { CallType, PlaybookSource } from './playbooks/source.js';
import { loadReplayInput, runReplay } from './replay.js';
import { RtmsSource } from './sources/rtms.js';
import type { TranscriptSource } from './sources/types.js';
import { urlValidation, verifySignature } from './webhook.js';
import { COACH_PAGE } from './web/page.js';

const START = ['meeting.rtms_started', 'webinar.rtms_started'];
const STOP = ['meeting.rtms_stopped', 'webinar.rtms_stopped'];

export interface AppDeps {
  source?: TranscriptSource;
  config?: Config;
  models?: { cue: CueModel; state: CueModel };
  playbooks?: PlaybookSource | null;
}

function defaultModels(cfg: Config) {
  if (!cfg.anthropicKey) return { cue: new StubModel(), state: new StubModel() };
  return { cue: new AnthropicModel(cfg.anthropicKey, cfg.cueModel), state: new AnthropicModel(cfg.anthropicKey, cfg.stateModel) };
}

export function buildApp(depsOrSource: AppDeps | TranscriptSource = {}) {
  const deps: AppDeps = 'start' in depsOrSource ? { source: depsOrSource as TranscriptSource } : (depsOrSource as AppDeps);
  const cfg = deps.config ?? loadConfig();
  const source = deps.source ?? new RtmsSource();
  const models = deps.models ?? defaultModels(cfg);
  const playbooks =
    deps.playbooks !== undefined
      ? deps.playbooks
      : cfg.databaseUrl
        ? new SupabasePlaybookSource(cfg.databaseUrl, cfg.matchWindowBeforeMin, cfg.matchWindowAfterMin)
        : null;
  const hub = new Hub(cfg, models, playbooks);

  const app = Fastify({ logger: true });
  const streams = new Set<string>(); // by rtms_stream_id: webhook retries must not open a second session

  // Keep the raw body: the Zoom signature is computed over it.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, { raw: body as string, json: JSON.parse((body as string) || '{}') });
    } catch (e: any) {
      done(e);
    }
  });

  app.get('/health', async () => ({
    ok: true,
    activeSessions: hub.activeCount,
    model: models.cue.id,
    playbooks: playbooks ? 'connected' : 'not configured',
    zoomSecret: cfg.zoomSecret ? 'set' : 'missing',
    coachPage: cfg.coachToken ? 'enabled' : 'disabled (COACH_TOKEN not set)',
  }));

  app.post('/webhook', async (req, reply) => {
    const { raw, json } = req.body as { raw: string; json: any };
    if (json.event === 'endpoint.url_validation') {
      return reply.send(urlValidation(json.payload.plainToken, cfg.zoomSecret));
    }
    if (!cfg.skipSignature && !verifySignature(raw, req.headers, cfg.zoomSecret)) {
      return reply.code(401).send({ error: 'bad signature' });
    }
    reply.code(200).send({ ok: true }); // respond first: slow responses cause Zoom retries and duplicate streams

    const { event, payload } = json;
    const streamId: string | undefined = payload?.rtms_stream_id;
    app.log.info({ event, streamId }, 'WEBHOOK EVENT');
    if (START.includes(event) && streamId && !streams.has(streamId)) {
      streams.add(streamId);
      void hub.start(streamId, payload.meeting_uuid ?? payload.session_id ?? streamId);
      source.start(payload, (e) => {
        hub.handle(streamId, e);
        if (e.kind !== 'transcript') app.log.info({ streamId, ...e }, 'RTMS EVENT');
      });
    } else if (STOP.includes(event) && streamId) {
      source.stop(streamId);
      hub.handle(streamId, { kind: 'session_stop', meetingUuid: payload.meeting_uuid });
      streams.delete(streamId);
    }
  });

  // ---- Coach page and its API. Prospect data: every route needs the coach token. ----
  const COOKIE = 'coach_key';
  const authed = (req: any) => {
    if (!cfg.coachToken) return false;
    const fromCookie = /(?:^|;\s*)coach_key=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const given = (req.query?.key as string | undefined) ?? (fromCookie ? decodeURIComponent(fromCookie) : '');
    const a = Buffer.from(String(given)), b = Buffer.from(cfg.coachToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const guard = async (req: any, reply: any) => {
    if (!cfg.coachToken) return reply.code(503).type('text/plain').send('Coach page disabled: set COACH_TOKEN on the server.');
    if (!authed(req)) return reply.code(401).type('text/plain').send('Open this page with ?key=<your coach token>.');
  };

  app.get('/', { preHandler: guard }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.key) {
      // Swap the key in the URL for a cookie, so it isn't left in the address bar or history.
      reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(q.key)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`);
      return reply.redirect('/');
    }
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').type('text/html').send(COACH_PAGE);
  });

  app.get('/events', { preHandler: guard }, (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const unsub = hub.subscribe(send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  });

  app.get('/api/calls', { preHandler: guard }, async () => hub.recentCalls());
  app.post('/api/feedback', { preHandler: guard }, async (req) => {
    const { json } = req.body as { json: { cueId: string; label: string } };
    return { ok: hub.feedback(json.cueId, json.label) };
  });
  app.post('/api/settings', { preHandler: guard }, async (req) => {
    const { json } = req.body as { json: { cueRate: CueRate } };
    return { ok: json.cueRate in CUE_RATES && hub.setCueRate(json.cueRate) };
  });
  app.post('/api/call', { preHandler: guard }, async (req) => {
    const { json } = req.body as { json: { callId?: string | null; callType?: CallType } };
    return { ok: await hub.pickCall(json.callId ?? null, json.callType) };
  });

  // ---- Replay benchmark: runs a past call through the engine with the server's own keys. ----
  const jobs = new Map<string, { status: 'running' | 'done' | 'error'; startedAt: number; summary?: unknown; error?: string; file?: string }>();
  app.post('/api/replay', { preHandler: guard }, async (req, reply) => {
    const { json } = req.body as { json: { callId: string; model?: string; rate?: CueRate; callType?: CallType } };
    if (!cfg.databaseUrl) return reply.code(400).send({ error: 'HOURSBACK_DB_URL not set' });
    if (!json?.callId) return reply.code(400).send({ error: 'callId required' });
    const id = crypto.randomUUID().slice(0, 8);
    jobs.set(id, { status: 'running', startedAt: Date.now() });
    const modelId = json.model ?? cfg.cueModel;
    void (async () => {
      try {
        const input = await loadReplayInput(json.callId, cfg.databaseUrl);
        const result = await runReplay(input, {
          cueModel: cfg.anthropicKey ? new AnthropicModel(cfg.anthropicKey, modelId) : new StubModel(),
          stateModel: models.state,
          hostName: cfg.hostName,
          rate: json.rate && json.rate in CUE_RATES ? json.rate : cfg.cueRate,
          callType: json.callType,
        });
        const dir = path.join(cfg.dataDir, 'replays');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}_${json.callId.slice(0, 8)}_${result.summary.model}_${result.summary.cueRate}.json`);
        fs.writeFileSync(file, JSON.stringify(result, null, 2));
        jobs.set(id, { status: 'done', startedAt: jobs.get(id)!.startedAt, summary: result.summary, file });
      } catch (err) {
        jobs.set(id, { status: 'error', startedAt: jobs.get(id)!.startedAt, error: String(err).slice(0, 300) });
      }
    })();
    return { jobId: id };
  });
  app.get('/api/replay/:id', { preHandler: guard }, async (req, reply) => {
    const job = jobs.get((req.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: 'no such job' });
    if (job.status !== 'done' || !job.file) return job;
    const full = JSON.parse(fs.readFileSync(job.file, 'utf8'));
    return { ...job, markdown: full.markdown };
  });

  return Object.assign(app, { hub });
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  const cfg = loadConfig();
  buildApp({ config: cfg }).listen({ port: cfg.port, host: '0.0.0.0' });
}
