import pg from 'pg';
import { playbookHtmlToText } from './html.js';
import { guessCallType, guessSector, type CallCandidate, type PlaybookBundle, type PlaybookSource } from './source.js';

/**
 * Reads playbooks from the HoursBack Supabase project, read-only.
 *
 * Source of truth decision (18 Nov 2026): `prospect_documents` (kind = 'playbook') on the
 * prospect's `prospect_calls` row. It is the only store that says WHICH call a playbook
 * belongs to, and the only one a hosted server can reach. The `tasks/` files on David's
 * Mac and in git have no link to a booking, so a playbook must be stored on the row
 * (store-prospect-doc skill) for the coach to see it.
 */
export class SupabasePlaybookSource implements PlaybookSource {
  private pool: pg.Pool;

  constructor(
    databaseUrl: string,
    private windowBeforeMin: number,
    private windowAfterMin: number,
  ) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 3, ssl: { rejectUnauthorized: false } });
  }

  async candidatesNear(at: Date): Promise<CallCandidate[]> {
    // A booking counts if the call started between `before` minutes ahead of its slot and
    // `after` minutes past it. Nearest slot first.
    const { rows } = await this.pool.query(
      `select p.id, p.scheduled_at, coalesce(p.display_name, left(p.business, 60), 'Unnamed booking') as label,
              exists (select 1 from prospect_documents d where d.prospect_call_id = p.id and d.kind = 'playbook') as has_playbook
         from prospect_calls p
        where p.scheduled_at between $1::timestamptz - make_interval(mins => $3) and $1::timestamptz + make_interval(mins => $2)
        order by abs(extract(epoch from (p.scheduled_at - $1::timestamptz)))
        limit 5`,
      [at.toISOString(), this.windowBeforeMin, this.windowAfterMin],
    );
    return rows.map((r) => ({ id: r.id, label: r.label, scheduledAt: r.scheduled_at?.toISOString?.() ?? null, hasPlaybook: r.has_playbook }));
  }

  /** Recent bookings, for the manual picker on the coach page. */
  async recent(limit = 15): Promise<CallCandidate[]> {
    const { rows } = await this.pool.query(
      `select p.id, p.scheduled_at, coalesce(p.display_name, left(p.business, 60), 'Unnamed booking') as label,
              exists (select 1 from prospect_documents d where d.prospect_call_id = p.id and d.kind = 'playbook') as has_playbook
         from prospect_calls p
        where p.scheduled_at > now() - interval '14 days'
        order by p.scheduled_at desc
        limit $1`,
      [limit],
    );
    return rows.map((r) => ({ id: r.id, label: r.label, scheduledAt: r.scheduled_at?.toISOString?.() ?? null, hasPlaybook: r.has_playbook }));
  }

  async load(callId: string): Promise<PlaybookBundle> {
    const call = (
      await this.pool.query(
        `select id, business, display_name, call_notes, scheduled_at from prospect_calls where id = $1`,
        [callId],
      )
    ).rows[0];
    if (!call) throw new Error(`No prospect_calls row ${callId}`);

    // Several versions often sit side by side ("v2", "v4 FINAL"). Newest wins.
    const pb = (
      await this.pool.query(
        `select title, content_html, created_at from prospect_documents
          where prospect_call_id = $1 and kind = 'playbook' and content_html is not null
          order by created_at desc limit 1`,
        [callId],
      )
    ).rows[0];
    const research = (
      await this.pool.query(
        `select title, content_html from prospect_documents
          where prospect_call_id = $1 and kind = 'research' and content_html is not null
          order by created_at desc limit 1`,
        [callId],
      )
    ).rows[0];

    return buildBundle({
      callId,
      label: call.display_name ?? call.business ?? 'Unnamed booking',
      business: call.business,
      callNotes: call.call_notes,
      playbook: pb ? { title: pb.title, html: pb.content_html, createdAt: pb.created_at.toISOString() } : null,
      research: research ? { title: research.title, html: research.content_html } : null,
    });
  }
}

export interface RawCallMaterial {
  callId: string | null;
  label: string;
  business: string | null;
  callNotes: string | null;
  playbook: { title: string; html: string; createdAt: string } | null;
  research: { title: string; html: string } | null;
}

const MAX_CONTEXT_CHARS = 12_000;

/** Shared by the live source and the replay harness, so both see exactly the same grounding. */
export function buildBundle(m: RawCallMaterial): PlaybookBundle {
  const warnings: string[] = [];
  const prospectPlaybook = m.playbook
    ? { title: m.playbook.title, text: playbookHtmlToText(m.playbook.html), createdAt: m.playbook.createdAt }
    : null;
  if (!prospectPlaybook) warnings.push('No prospect playbook stored on this booking - cues use the generic framework only.');

  const ctx: string[] = [];
  if (m.business) ctx.push(`Business: ${m.business}`);
  if (m.callNotes) ctx.push(`Call notes and pre-call context:\n${m.callNotes}`);
  if (m.research) ctx.push(`Research (${m.research.title}):\n${playbookHtmlToText(m.research.html)}`);
  let prospectContext = ctx.join('\n\n');
  if (prospectContext.length > MAX_CONTEXT_CHARS) prospectContext = prospectContext.slice(0, MAX_CONTEXT_CHARS) + '\n[truncated]';

  const callType = guessCallType({ business: m.business, hasPlaybook: !!prospectPlaybook, playbookTitle: m.playbook?.title });
  const sector = prospectPlaybook ? null : guessSector(m.business);
  if (sector) warnings.push(`Using the nearest sector playbook: ${sector}.`);

  return { callId: m.callId, label: m.label, callType, prospectPlaybook, prospectContext, sector, warnings };
}
