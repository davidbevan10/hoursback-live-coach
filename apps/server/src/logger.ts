import fs from 'node:fs';
import path from 'node:path';
import type { CoachEvent } from './sources/types.js';

/** Append-only JSONL per session. Every line carries receivedAt (ms epoch, this server's clock). */
export function openSessionLog(dataDir: string, meetingUuid: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const safe = meetingUuid.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(dataDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${safe}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  return {
    file,
    write(e: CoachEvent) {
      stream.write(JSON.stringify({ receivedAt: Date.now(), ...e }) + '\n');
    },
    close() { stream.end(); },
  };
}
