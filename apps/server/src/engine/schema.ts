import { z } from 'zod';

const words = (max: number) => (s: string) => s.trim().split(/\s+/).filter(Boolean).length <= max;

/** One cue, exactly the brief's section 5 schema. Anything that fails validation is dropped, never shown. */
export const CueSchema = z
  .object({
    type: z.enum(['objection', 'buying_signal', 'probe', 'stage_shift', 'none']),
    headline: z.string().max(80).refine(words(10), 'headline over 8 words'),
    say_this: z.string().max(240).refine(words(30), 'say_this over 25 words'),
    why: z.string().max(120).refine(words(15), 'why over 12 words'),
    playbook_ref: z.string().max(160),
    confidence: z.number().min(0).max(1),
  })
  .refine((c) => c.type === 'none' || c.playbook_ref.trim().length > 0, 'cue without playbook_ref');

export type Cue = z.infer<typeof CueSchema>;

/** Coverage checklist kept by the slower state tracker. */
export const StateSchema = z.object({
  stage: z.string().max(60),
  covered: z.array(z.string().max(120)).max(20),
  missing: z.array(z.string().max(120)).max(20),
  top_gaps: z.array(z.string().max(120)).max(2),
});

export type CallState = z.infer<typeof StateSchema>;

/** Pull the first JSON object out of a model reply (models sometimes wrap it in prose or fences). */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(raw.slice(start, end + 1));
}
