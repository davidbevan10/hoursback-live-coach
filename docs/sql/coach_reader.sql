-- Read-only login for the live coach on the HoursBack Supabase project.
-- Run once in the Supabase SQL editor. Replace CHOOSE_A_LONG_PASSWORD first.
-- It can only SELECT three tables, and only because of the explicit policies below
-- (RLS is on for all three, so without a policy it would see no rows).

create role coach_reader login password 'CHOOSE_A_LONG_PASSWORD' connection limit 5;

grant usage on schema public to coach_reader;
grant select on public.prospect_calls, public.prospect_documents, public.prospect_call_events to coach_reader;

create policy coach_reader_select on public.prospect_calls for select to coach_reader using (true);
create policy coach_reader_select on public.prospect_documents for select to coach_reader using (true);
create policy coach_reader_select on public.prospect_call_events for select to coach_reader using (true);

-- Connection string for Railway's HOURSBACK_DB_URL (session pooler, IPv4, eu-central-1):
-- postgresql://coach_reader.fotqbjxxysnkmwyjrxup:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
-- Check the exact pooler host on Supabase > Connect > Session pooler.

-- To remove it later:
-- drop policy coach_reader_select on public.prospect_calls;
-- drop policy coach_reader_select on public.prospect_documents;
-- drop policy coach_reader_select on public.prospect_call_events;
-- revoke all on public.prospect_calls, public.prospect_documents, public.prospect_call_events from coach_reader;
-- revoke usage on schema public from coach_reader;
-- drop role coach_reader;
