-- Lead tracker link: lets the Google Sheet lead tracker read your booked jobs.
-- Run once in Supabase → SQL Editor. Running it again is safe and keeps the same key.
-- The result at the bottom shows your private key: paste it into the sheet's script.
-- Only someone with that key can read the list, and it can only read (never change) anything.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.tracker_feed (
  user_id uuid primary key references auth.users (id) on delete cascade,
  key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);

-- The app has one account (yours), so the key belongs to the first user.
insert into private.tracker_feed (user_id)
select id from auth.users order by created_at limit 1
on conflict (user_id) do nothing;

-- Returns every booked job with the customer's name and phone.
create or replace function public.tracker_feed(feed_key text)
returns jsonb
language sql
stable
security definer
set search_path = public, private
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'date', j.data->>'date',
      'price', j.data->'price',
      'title', j.data->>'title',
      'done', coalesce((j.data->>'done')::boolean, false),
      'customerId', j.data->>'customerId',
      'name', c.data->>'name',
      'phone', c.data->>'phone'
    ) order by j.data->>'date'), '[]'::jsonb)
  from private.tracker_feed f
  join public.records j on j.user_id = f.user_id and j.col = 'jobs'
  left join public.records c on c.user_id = f.user_id and c.col = 'customers' and c.id = j.data->>'customerId'
  where length(coalesce(feed_key, '')) >= 32 and f.key = feed_key;
$$;

revoke all on function public.tracker_feed(text) from public;
grant execute on function public.tracker_feed(text) to anon, authenticated;

select key as "Your tracker key (copy this)" from private.tracker_feed;
