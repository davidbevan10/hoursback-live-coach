import Anthropic from '@anthropic-ai/sdk';

export interface ModelCall {
  rules: string;
  grounding: string;
  user: string;
  maxTokens: number;
}

export interface ModelResult {
  text: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface CueModel {
  readonly id: string;
  complete(call: ModelCall): Promise<ModelResult>;
}

/** Claude with the rules + playbook blocks marked for prompt caching. */
export class AnthropicModel implements CueModel {
  private client: Anthropic;
  constructor(apiKey: string, readonly id: string) {
    // A hung call blocks every later cue, so fail fast: one cue arriving late is worth nothing.
    this.client = new Anthropic({ apiKey, timeout: 8000, maxRetries: 1 });
  }

  async complete(call: ModelCall): Promise<ModelResult> {
    const t0 = Date.now();
    const res = await this.client.messages.create({
      model: this.id,
      max_tokens: call.maxTokens,
      // Newer models think before answering by default. Thinking eats the small token budget and
      // the reply arrives with no JSON in it, so it is off: these are short, fast judgement calls.
      thinking: { type: 'disabled' },
      system: [
        { type: 'text', text: call.rules },
        { type: 'text', text: call.grounding, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: call.user }],
    });
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    if (!text.includes('{')) {
      throw new Error(`no JSON in reply (stop_reason ${res.stop_reason}, blocks ${res.content.map((b) => b.type).join('+') || 'none'}): ${text.slice(0, 60)}`);
    }
    return {
      text,
      model: this.id,
      latencyMs: Date.now() - t0,
      inputTokens: res.usage.input_tokens,
      cachedInputTokens: res.usage.cache_read_input_tokens ?? 0,
      outputTokens: res.usage.output_tokens,
    };
  }
}

/**
 * Offline stand-in so the pipeline, triggers and display can be tested with no API key.
 * Emits a probe when the prospect mentions time or cost, otherwise none.
 */
export class StubModel implements CueModel {
  readonly id = 'stub';
  async complete(call: ModelCall): Promise<ModelResult> {
    const isState = call.user.startsWith('You track playbook coverage');
    let text: string;
    if (isState) {
      text = JSON.stringify({ stage: 'questions', covered: ['The starting point'], missing: ['Hours a week it costs', 'Who approves'], top_gaps: ['Get the hours number', 'Who signs'] });
    } else {
      const last = call.user.split('\n').filter((l) => l.startsWith('PROSPECT')).pop() ?? '';
      text = /hour|time|cost|price|budget/i.test(last)
        ? JSON.stringify({ type: 'probe', headline: 'Pin the number down', say_this: 'Roughly how many hours a week is that, and whose desk does it land on?', why: 'No hours figure confirmed yet', playbook_ref: 'Q4. The number (this is the one)', confidence: 0.7 })
        : JSON.stringify({ type: 'none', headline: '', say_this: '', why: '', playbook_ref: '', confidence: 0 });
    }
    return { text, model: this.id, latencyMs: 5, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  }
}
