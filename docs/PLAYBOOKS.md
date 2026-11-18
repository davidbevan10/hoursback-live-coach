# Where the coach gets its playbooks

Decision, 18 Nov 2026.

## Source of truth: the prospect's row in Supabase

The coach reads the newest `prospect_documents` row with `kind = 'playbook'` on the
booking's `prospect_calls` row, plus the newest `research` document and the business line.
It reads nothing else from HoursBack and writes nothing.

Why this store and not `tasks/` or git:

- It is the only place that says which call a playbook belongs to. A file in `tasks/`
  has a name and a date, but no link to a booking, so matching would be guesswork.
- A hosted server can reach it. `tasks/` lives on David's Mac and in a private git repo
  that saves new files in batches, so the newest playbooks are often only on the Mac.
- It is what David already sees in the admin under the prospect.

The rule that follows: **a playbook the coach should use must be stored on the prospect's
row** (the store-prospect-doc skill does this from a `tasks/` file). As of 18 Nov the newest
stored playbook is from 5 Nov; recent playbooks such as innergroup, innovestech and EKCS are
only in `tasks/`.

## Two layers

- **Layer 1, generic and static** (`apps/server/layer1/`): the SME 15-minute discovery
  framework (from `app/lib/discovery-call-framework.ts`) and the enterprise 20-minute intro
  (from `tasks/grip-playbooks/_BRIEF.md`), plus the four sector playbooks used as a fallback.
  Keep these in step with the HoursBack originals.
- **Layer 2, the prospect's own playbook**, loaded when the call starts. Where it disagrees
  with Layer 1, it wins.

## Which booking is "this call"

When Zoom starts the stream, the coach takes the booking whose `scheduled_at` is nearest,
from 20 minutes before to 60 minutes after its slot. The coach page shows what it picked and
lets David switch booking or call type mid-call.

## Versions

Several versions often sit side by side ("v2", "v4 FINAL"). The newest by `created_at` wins.
Store the one you mean to use last.
