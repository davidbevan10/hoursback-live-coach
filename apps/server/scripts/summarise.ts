// Usage: npm run summarise -w @coach/server -- data/<file>.jsonl
// Reports transcript lag (receivedAt - sourceTs), gaps and speaker split. Lag is only meaningful if the
// SDK timestamp is a wall-clock ms epoch and your clock is NTP-synced; otherwise use the stopwatch test in docs/PHASE0.md.
import fs from 'node:fs';
const file = process.argv[2];
if (!file) { console.error('pass a jsonl path'); process.exit(1); }
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const tr = rows.filter((r) => r.kind === 'transcript');
console.log(`events: ${rows.length}, transcript lines: ${tr.length}`);
const bySpeaker: Record<string, number> = {};
tr.forEach((r) => (bySpeaker[r.speaker] = (bySpeaker[r.speaker] ?? 0) + 1));
console.log('by speaker:', bySpeaker);
const lags = tr.filter((r) => r.sourceTs).map((r) => r.receivedAt - (r.sourceTs > 1e12 ? r.sourceTs : r.sourceTs * 1000));
if (lags.length) {
  lags.sort((a, b) => a - b);
  const q = (p: number) => lags[Math.min(lags.length - 1, Math.floor(p * lags.length))];
  console.log(`lag ms  p50=${q(0.5)}  p95=${q(0.95)}  max=${lags[lags.length - 1]}  (negative/huge values = timestamp is not wall-clock)`);
}
const gaps = tr.slice(1).map((r, i) => r.receivedAt - tr[i].receivedAt).filter((g) => g > 15000);
console.log(`gaps > 15s between transcript lines: ${gaps.length}`);
const first = rows.find((r) => r.kind === 'session_start'), join = rows.find((r) => r.kind === 'join_confirm');
if (first && join) console.log(`start -> join_confirm: ${join.receivedAt - first.receivedAt} ms (reason ${join.reason})`);
