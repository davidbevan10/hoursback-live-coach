import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Which generic framework applies. Scoping, review and follow-up calls run on the prospect playbook only. */
export type CallType = 'sme_discovery' | 'enterprise_intro' | 'other';

export type Sector = 'insurance-broker-groups' | 'insurance-london-market' | 'recruitment-contract' | 'recruitment-education-supply';

/** A booked call the coach could be attached to (a prospect_calls row). */
export interface CallCandidate {
  id: string;
  label: string;
  scheduledAt: string | null;
  hasPlaybook: boolean;
}

/** Everything the cue engine is grounded in for one call. */
export interface PlaybookBundle {
  callId: string | null;
  label: string;
  callType: CallType;
  /** Layer 2: the prospect's own playbook as plain text, newest version. Null when none is stored. */
  prospectPlaybook: { title: string; text: string; createdAt: string } | null;
  /** Extra prospect context: business line, call notes (the pre-call context pack), latest research doc. */
  prospectContext: string;
  sector: Sector | null;
  /** Shown on the coach page so David knows what the cues are grounded in. */
  warnings: string[];
}

export interface PlaybookSource {
  /** Bookings whose scheduled time is near `at`, nearest first. */
  candidatesNear(at: Date): Promise<CallCandidate[]>;
  load(callId: string): Promise<PlaybookBundle>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const LAYER1_DIR = path.resolve(here, '../../layer1');

function read(rel: string) {
  return fs.readFileSync(path.join(LAYER1_DIR, rel), 'utf8').replace(/^<!--.*?-->\n/s, '');
}

/** Layer 1: generic frameworks, static, prompt-cached. */
export function layer1Text(callType: CallType, sector: Sector | null): string {
  const parts: string[] = [read('pitfalls.md')];
  if (callType === 'sme_discovery') parts.push(read('sme-discovery-15.md'));
  if (callType === 'enterprise_intro') parts.push(read('enterprise-intro-20.md'));
  if (callType === 'other') {
    parts.push('# No generic framework applies to this call type. Ground every cue in the prospect playbook below.');
  }
  if (sector) parts.push(`# Nearest sector playbook (use only if it fits this prospect)\n\n${read(`sectors/${sector}.md`)}`);
  return parts.join('\n\n---\n\n');
}

/** Cheap guess at the sector from the business description, for the fallback when no prospect playbook exists. */
export function guessSector(business: string | null): Sector | null {
  const b = (business ?? '').toLowerCase();
  if (/lloyd|london market|managing general|mga|reinsur|syndicate/.test(b)) return 'insurance-london-market';
  if (/insur|broker/.test(b)) return 'insurance-broker-groups';
  if (/supply teach|education recruit|school/.test(b)) return 'recruitment-education-supply';
  if (/recruit|staffing|talent|umbrella/.test(b)) return 'recruitment-contract';
  return null;
}

/**
 * Call type from what we know about the booking. A 15-min discovery is an owner-managed
 * small business; anything with a big headcount or an enterprise title is the 20-min intro.
 * The coach page lets David override this on the call.
 */
export function guessCallType(opts: { business: string | null; hasPlaybook: boolean; playbookTitle?: string | null }): CallType {
  const t = `${opts.playbookTitle ?? ''} ${opts.business ?? ''}`.toLowerCase();
  if (/follow-up|follow up|scoping|review|decision|check-in|checkin|catch-?up|walkthrough|setup|go-live|workshop/.test(opts.playbookTitle?.toLowerCase() ?? '')) return 'other';
  if (/enterprise|[0-9],?[0-9]{3}[- ]?(person|people|staff|employee)|plc|group|nhs|council|hmrc|government|board/.test(t)) return 'enterprise_intro';
  return 'sme_discovery';
}
