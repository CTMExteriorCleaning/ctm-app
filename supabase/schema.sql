-- CTM Quoting & CRM: run once in Supabase → SQL Editor.
-- Every record (customer, quote, invoice, job, service, setting) is one row,
-- and each signed-in user can only ever see and change their own rows.

create table if not exists public.records (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  col text not null check (col in ('customers', 'quotes', 'invoices', 'jobs', 'services', 'settings')),
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, col, id)
);

alter table public.records enable row level security;

drop policy if exists "Own records only" on public.records;
create policy "Own records only" on public.records
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Live sync between phone and laptop
alter table public.records replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object then null; end $$;
