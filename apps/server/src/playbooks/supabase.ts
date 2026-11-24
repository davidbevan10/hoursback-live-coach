import pg from 'pg';
import { playbookHtmlToText } from './html.js';
import { guessCallType, guessSector, type CallCandidate, type CallStage, type PlaybookBundle, type PlaybookSource } from './source.js';

/**
 * Reads playbooks from the HoursBack Supabase project, read-only.
 *
 * Source of truth decision (18 Nov 2026): `prospect_documents` (kind = 'playbook', or an analysis/other
 * document whose title says playbook, since some get stored that way) on the
 * prospect's `prospect_calls` row. It is the only store that says WHICH call a playbook
 * belongs to, and the only one a hosted server can reach. The `tasks/` files on David's
 * Mac and in git have no link to a booking, so a playbook must be stored on the row
 * (store-prospect-doc skill) for the coach to see it.
 */
const HAS_PLAYBOOK = `exists (select 1 from prospect_documents d where d.prospect_call_id = p.id and (d.kind = 'playbook' or (d.kind in ('analysis', 'other') and d.title ilike '%playbook%'))) as has_playbook`;

/** The person's name and business from the CRM contact, falling back to what's on the booking. */
const LABEL_WITH_CONTACT = `coalesce(nullif(concat_ws(' - ', c.name, c.business_name), ''), p.display_name, left(p.business, 60), 'Unnamed booking') as label`;
const LABEL_BOOKING_ONLY = `coalesce(p.display_name, left(p.business, 60), 'Unnamed booking') as label`;

export class SupabasePlaybookSource implements PlaybookSource {
  private pool: pg.Pool;
  /** Flips to false if coach_reader can't read contacts yet (docs/sql/coach_reader_contacts.sql), so the picker still works. */
  private contactsReadable = true;

  /** Run a booking-list query with contact names, or without them if that table isn't granted. */
  private async bookings(where: string, order: string, params: unknown[]) {
    const sql = (withContacts: boolean) =>
      `select p.id, p.scheduled_at, ${withContacts ? LABEL_WITH_CONTACT : LABEL_BOOKING_ONLY}, ${HAS_PLAYBOOK}
         from prospect_calls p ${withContacts ? 'left join contacts c on c.id = p.contact_id' : ''}
        where ${where} order by ${order}`;
    if (this.contactsReadable) {
      try {
        return (await this.pool.query(sql(true), params)).rows;
      } catch (err: any) {
        if (err?.code !== '42501') throw err; // only "permission denied" falls back
        this.contactsReadable = false;
        console.log(JSON.stringify({ msg: 'PLAYBOOK DB: contacts not readable by coach_reader, showing booking names only' }));
      }
    }
    return (await this.pool.query(sql(false), params)).rows;
  }

  constructor(
    private databaseUrl: string,
    private windowBeforeMin: number,
    private windowAfterMin: number,
  ) {
    this.pool = makePool(databaseUrl);
  }

  /**
   * Try the configured URL, then the direct database host if the URL is Supabase's shared
   * pooler. Keeps whichever logs in. Returns which route worked, or throws both errors.
   * (The direct host is IPv6-only, which Railway reaches once IPv6 egress is on.)
   */
  async connectCheck(): Promise<'pooler' | 'direct' | 'configured'> {
    try {
      await this.pool.query('select 1');
      return isSharedPooler(this.databaseUrl) ? 'pooler' : 'configured';
    } catch (first) {
      const direct = directVariant(this.databaseUrl);
      if (!direct) throw first;
      const pool = makePool(direct);
      try {
        await pool.query('select 1');
      } catch (second) {
        await pool.end().catch(() => {});
        throw new Error(`pooler: ${String(first).slice(0, 90)} | direct: ${String(second).slice(0, 90)}`);
      }
      const old = this.pool;
      this.pool = pool;
      void old.end().catch(() => {});
      return 'direct';
    }
  }

  async candidatesNear(at: Date): Promise<CallCandidate[]> {
    // A booking counts if the call started between `before` minutes ahead of its slot and
    // `after` minutes past it. Nearest slot first.
    const rows = await this.bookings(
      `p.scheduled_at between $1::timestamptz - make_interval(mins => $3::int) and $1::timestamptz + make_interval(mins => $2::int)`,
      `abs(extract(epoch from (p.scheduled_at - $1::timestamptz))) limit 5`,
      [at.toISOString(), this.windowBeforeMin, this.windowAfterMin],
    );
    return rows.map((r) => ({ id: r.id, label: r.label, scheduledAt: r.scheduled_at?.toISOString?.() ?? null, hasPlaybook: r.has_playbook }));
  }

  /** Bookings for the manual picker on the coach page: last 14 days and upcoming, nearest to now first. */
  async recent(limit = 15): Promise<CallCandidate[]> {
    const rows = await this.bookings(`p.scheduled_at > now() - interval '14 days'`, `abs(extract(epoch from (p.scheduled_at - now()))) limit $1`, [limit]);
    return rows.map((r) => ({ id: r.id, label: r.label, scheduledAt: r.scheduled_at?.toISOString?.() ?? null, hasPlaybook: r.has_playbook }));
  }

  async load(callId: string): Promise<PlaybookBundle> {
    const call = (
      await this.pool.query(
        `select p.id, p.business, p.display_name, p.call_notes, p.scheduled_at,
                (select count(*) from prospect_calls q
                  where q.contact_id = p.contact_id and q.id <> p.id and q.status = 'completed'
                    and q.scheduled_at < coalesce(p.scheduled_at, now()))::int as earlier_calls
           from prospect_calls p where p.id = $1`,
        [callId],
      )
    ).rows[0];
    if (!call) throw new Error(`No prospect_calls row ${callId}`);

    // Several versions often sit side by side ("v2", "v4 FINAL"). Newest wins.
    const pb = (
      await this.pool.query(
        `select title, content_html, created_at from prospect_documents
          where prospect_call_id = $1 and (kind = 'playbook' or (kind in ('analysis', 'other') and title ilike '%playbook%')) and content_html is not null
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

    let label = call.display_name ?? call.business ?? 'Unnamed booking';
    if (this.contactsReadable) {
      try {
        const c = (await this.pool.query(`select c.name, c.business_name from prospect_calls p join contacts c on c.id = p.contact_id where p.id = $1`, [callId])).rows[0];
        if (c?.name) label = [c.name, c.business_name].filter(Boolean).join(' - ');
      } catch (err: any) {
        if (err?.code === '42501') this.contactsReadable = false;
      }
    }

    return buildBundle({
      callId,
      label,
      earlierCalls: call.earlier_calls,
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
  /** Completed calls with the same contact before this one. Unknown (replays, fixtures) counts as none. */
  earlierCalls?: number;
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
  const followUpTitle = /follow-?up|review|catch-?up|check-?in|decision|second call|go-?live|walkthrough/i.test(m.playbook?.title ?? '');
  const stage: CallStage = (m.earlierCalls ?? 0) > 0 || followUpTitle ? 'follow_up' : 'first';
  const sector = prospectPlaybook ? null : guessSector(m.business);
  if (sector) warnings.push(`Using the nearest sector playbook: ${sector}.`);

  return { callId: m.callId, label: m.label, callType, stage, prospectPlaybook, prospectContext, sector, warnings };
}

function makePool(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 3, ssl: { rejectUnauthorized: false } });
  // Without a listener, a dropped idle connection is an uncaught error that kills the process mid-call.
  pool.on('error', (err) => console.error('playbook db pool error', err.message));
  return pool;
}

function isSharedPooler(url: string) {
  try {
    return new URL(url).hostname.endsWith('pooler.supabase.com');
  } catch {
    return false;
  }
}

/** postgresql://role.<ref>:pw@aws-x-<region>.pooler.supabase.com:5432/postgres -> postgresql://role:pw@db.<ref>.supabase.co:5432/postgres */
export function directVariant(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('pooler.supabase.com')) return null;
    const user = decodeURIComponent(u.username);
    const dot = user.lastIndexOf('.');
    if (dot < 1) return null;
    u.username = encodeURIComponent(user.slice(0, dot));
    u.hostname = `db.${user.slice(dot + 1)}.supabase.co`;
    u.port = '5432';
    return u.toString();
  } catch {
    return null;
  }
}
