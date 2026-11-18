import Fastify from 'fastify';
import { RtmsSource } from './sources/rtms.js';
import type { CoachEvent, TranscriptSource } from './sources/types.js';
import { openSessionLog } from './logger.js';
import { urlValidation, verifySignature } from './webhook.js';

const START = ['meeting.rtms_started', 'webinar.rtms_started'];
const STOP = ['meeting.rtms_stopped', 'webinar.rtms_stopped'];

export function buildApp(source: TranscriptSource = new RtmsSource()) {
  const SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN ?? '';
  const DATA_DIR = process.env.DATA_DIR ?? './data';
  const SKIP_SIG = process.env.SKIP_SIGNATURE_CHECK === '1';
  const app = Fastify({ logger: true });
  const logs = new Map<string, ReturnType<typeof openSessionLog>>(); // by rtms_stream_id

  // Keep the raw body: signature is computed over it.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, { raw: body as string, json: JSON.parse(body as string) }); } catch (e: any) { done(e); }
  });

  app.get('/health', async () => ({ ok: true, activeSessions: logs.size }));

  app.post('/webhook', async (req, reply) => {
    const { raw, json } = req.body as { raw: string; json: any };

    if (json.event === 'endpoint.url_validation') {
      return reply.send(urlValidation(json.payload.plainToken, SECRET));
    }
    if (!SKIP_SIG && !verifySignature(raw, req.headers, SECRET)) {
      return reply.code(401).send({ error: 'bad signature' });
    }

    reply.code(200).send({ ok: true }); // respond first: slow responses cause Zoom retries and duplicate streams

    const { event, payload } = json;
    app.log.info({ event, streamId: payload?.rtms_stream_id }, 'WEBHOOK EVENT');
    const streamId: string | undefined = payload?.rtms_stream_id;
    if (START.includes(event) && streamId && !logs.has(streamId)) {
      const log = openSessionLog(DATA_DIR, payload.meeting_uuid);
      logs.set(streamId, log);
      app.log.info({ file: log.file }, 'RTMS started, logging');
      const emit = (e: CoachEvent) => { log.write(e); app.log.info({ streamId, ...e }, 'COACH EVENT'); };
      source.start(payload, emit);
    } else if (STOP.includes(event) && streamId) {
      source.stop(streamId);
      logs.get(streamId)?.write({ kind: 'session_stop', meetingUuid: payload.meeting_uuid });
      logs.get(streamId)?.close();
      logs.delete(streamId);
    }
  });
  return app;
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  buildApp().listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' });
}
