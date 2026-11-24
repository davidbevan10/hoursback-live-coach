-- Lets the live coach show the person's name and business in its booking picker.
-- Column-level: coach_reader can read only id, name and business_name from contacts,
-- never email, phone, notes or anything else. Run once in the Supabase SQL editor (hoursback).

grant select (id, name, business_name) on public.contacts to coach_reader;
create policy coach_reader_select on public.contacts for select to coach_reader using (true);

-- To remove:
-- drop policy coach_reader_select on public.contacts;
-- revoke select on public.contacts from coach_reader;
