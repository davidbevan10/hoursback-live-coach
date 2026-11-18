/**
 * Replay harness (Phase 1), command-line version. Plays a past call through the real cue
 * engine at simulated speaking speed and writes a report of every cue it would have shown.
 *
 *   npx tsx eval/replay.ts --call <prospect_calls id>     (needs HOURSBACK_DB_URL)
 *   npx tsx eval/replay.ts --file eval/fixtures/demo-call.json
 *   options: --model claude-sonnet-5-5   --rate balanced   --calltype enterprise_intro
 *
 * Needs ANTHROPIC_API_KEY for real cues; without it the stub model runs (pipeline check only).
 * The same replay runs on the server at POST /api/replay, using the server's own keys.
 * Output goes to eval/out (gitignored: prospect data).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type CueRate } from '../apps/server/src/config.js';
import { AnthropicModel, StubModel } from '../apps/server/src/engine/model.js';
import type { CallType } from '../apps/server/src/playbooks/source.js';
import { loadReplayInput, runReplay, type ReplayInput } from '../apps/server/src/replay.js';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const cfg = loadConfig();
const callId = arg('call');
const file = arg('file');
if (!callId && !file) throw new Error('pass --call <id> or --file <path>');
if (callId && !cfg.databaseUrl) throw new Error('HOURSBACK_DB_URL not set');
const input: ReplayInput = callId ? await loadReplayInput(callId, cfg.databaseUrl) : JSON.parse(fs.readFileSync(file!, 'utf8'));

const modelId = arg('model') ?? cfg.cueModel;
const result = await runReplay(input, {
  cueModel: cfg.anthropicKey ? new AnthropicModel(cfg.anthropicKey, modelId) : new StubModel(),
  stateModel: cfg.anthropicKey ? new AnthropicModel(cfg.anthropicKey, cfg.stateModel) : new StubModel(),
  hostName: arg('host') ?? cfg.hostName,
  rate: (arg('rate') ?? cfg.cueRate) as CueRate,
  callType: arg('calltype') as CallType | undefined,
});

const outDir = path.resolve('eval/out');
fs.mkdirSync(outDir, { recursive: true });
const slug = `${input.label}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + `-${result.summary.model}-${result.summary.cueRate}`;
fs.writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(outDir, `${slug}.md`), result.markdown);
console.log(JSON.stringify(result.summary, null, 2));
console.log(`Report: eval/out/${slug}.md`);
