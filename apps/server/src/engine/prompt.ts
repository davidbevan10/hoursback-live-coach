import { layer1Text, type PlaybookBundle } from '../playbooks/source.js';
import type { CallState, Cue } from './schema.js';

/**
 * The system prompt is split in two blocks so the big, stable one (rules + playbooks) is
 * prompt-cached for the whole call and each cue call only pays for the new transcript.
 */
export function systemBlocks(bundle: PlaybookBundle, hostName: string): { rules: string; grounding: string } {
  const rules = `You are a silent sales coach for ${hostName}, founder of HoursBack (UK). You watch the live transcript of his Zoom call and, only when it would genuinely help, suggest ONE short cue he can glance at on a second screen.

Rules:
- Bias strongly to "none". Silence is the default. On a good call, at least four out of five checks should return none. A cue is only worth it if David would clearly do something different because of it. Use confidence honestly: 0.8+ only when the moment is unmistakable.
- Every cue must cite playbook_ref: the heading text of the playbook section or framework item it comes from, copied from a "## " heading below. No ref, no cue.
- Never invent facts about HoursBack, pricing, figures, case studies or clients. Only use facts present in the playbooks and context below.
- Voice for say_this: ${hostName} speaking as "I", British English, plain, peer-to-peer, no jargon, no filler, no em dashes. Max 25 words.
- Hard limits, count the words: headline max 8 words, say_this max 25 words (one or two short sentences), why max 12 words. Shorter is better: David reads this mid-sentence.
- If the prospect is mid-thought, the last turn is small talk, or ${hostName} is already doing the right thing, return type "none".
- David's known pitfalls are listed first in the grounding. Catching one as it happens is the most valuable cue you can give: cite it as playbook_ref (for example "Pitfall: letting a vague answer pass"). The playbook still wins on what to say.
- When the trigger says DAVID has been talking a long time, consider the talking-too-long pitfall first.
- Prefer probes that close a real gap in the coverage state (a must-ask not yet asked, a number not yet confirmed, the decision-maker not yet named).
- Objection cues: use the playbook's own answer to that objection where one exists.
- stage_shift: only when it is clearly time to move on (for example the clock says close, or all must-asks are covered).
- Do not repeat or rephrase any of the recent cues already shown.

Types: objection (they pushed back or raised a concern), buying_signal (they showed intent; say how to move it forward), probe (a deeper follow-up question), stage_shift (move to the next part of the call), none.

Reply with ONLY a JSON object:
{"type":"objection|buying_signal|probe|stage_shift|none","headline":"","say_this":"","why":"","playbook_ref":"","confidence":0.0}
For "none", leave the text fields empty and set confidence to 0.`;

  const sections: string[] = [];
  sections.push(`# GENERIC FRAMEWORK (Layer 1, call type: ${bundle.callType})\n\n${layer1Text(bundle.callType, bundle.sector)}`);
  if (bundle.prospectPlaybook) {
    sections.push(`# PROSPECT PLAYBOOK (Layer 2) - "${bundle.prospectPlaybook.title}". Where it disagrees with the generic framework, this wins.\n\n${bundle.prospectPlaybook.text}`);
  }
  if (bundle.prospectContext) sections.push(`# PROSPECT CONTEXT\n\n${bundle.prospectContext}`);
  return { rules, grounding: sections.join('\n\n====\n\n') };
}

export interface Turn {
  speaker: string;
  role: 'host' | 'prospect';
  text: string;
  at: number;
}

export function cueUserMessage(opts: { turns: Turn[]; state: CallState | null; recentCues: Cue[]; elapsedMin: number; trigger?: string }): string {
  const transcript = opts.turns.map((t) => `${t.role === 'host' ? 'DAVID' : 'PROSPECT'} (${t.speaker}): ${t.text}`).join('\n');
  const state = opts.state
    ? `Stage: ${opts.state.stage}\nCovered: ${opts.state.covered.join('; ') || 'nothing yet'}\nMissing: ${opts.state.missing.join('; ') || 'unknown'}\nTop gaps: ${opts.state.top_gaps.join('; ') || 'none'}`
    : 'Not assessed yet.';
  const recent = opts.recentCues.length ? opts.recentCues.map((c) => `- [${c.type}] ${c.headline}: ${c.say_this}`).join('\n') : 'None.';
  return `Minutes into the call: ${opts.elapsedMin.toFixed(1)}
Why you are being asked now: ${opts.trigger ?? 'the prospect just finished a turn'}

Coverage state:
${state}

Recent cues already shown (do not repeat):
${recent}

Last ~90 seconds of transcript (most recent last):
${transcript}

Decide: one cue, or none.`;
}

export function stateUserMessage(opts: { turns: Turn[]; previous: CallState | null; elapsedMin: number }): string {
  const transcript = opts.turns.map((t) => `${t.role === 'host' ? 'DAVID' : 'PROSPECT'}: ${t.text}`).join('\n');
  return `You track playbook coverage for this call. ${opts.elapsedMin.toFixed(1)} minutes in.
Previous state: ${opts.previous ? JSON.stringify(opts.previous) : 'none'}

Full transcript so far:
${transcript}

Using the "Before you hang up" checklist and the must-ask questions in the playbooks above, reply with ONLY a JSON object:
{"stage":"open|questions|close|wrap-up (or a short label)","covered":["checklist items clearly covered"],"missing":["checklist items not yet covered"],"top_gaps":["the 2 most important gaps right now"]}`;
}
