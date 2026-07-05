-- GeoClock Web V0.4.2 trip notification mute table
-- 這是無登入 MVP 權限設計，正式版之後要改成登入與 owner 驗證。

create table if not exists public.trip_notification_mutes (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid,
  share_code text not null,
  role text not null,
  user_code text,
  endpoint text,
  event_type text not null default 'all',
  muted boolean not null default true,
  created_at timestamptz default now()
);

alter table public.notification_events
  drop constraint if exists notification_events_trip_id_event_type_key;

create index if not exists idx_trip_notification_mutes_share_role
on public.trip_notification_mutes (share_code, role);

create index if not exists idx_trip_notification_mutes_endpoint
on public.trip_notification_mutes (endpoint);

create index if not exists idx_trip_notification_mutes_user_code
on public.trip_notification_mutes (user_code);

alter table public.trip_notification_mutes enable row level security;

drop policy if exists "mvp anon select trip notification mutes" on public.trip_notification_mutes;
create policy "mvp anon select trip notification mutes"
on public.trip_notification_mutes
for select
to anon
using (true);

drop policy if exists "mvp anon insert trip notification mutes" on public.trip_notification_mutes;
create policy "mvp anon insert trip notification mutes"
on public.trip_notification_mutes
for insert
to anon
with check (true);

drop policy if exists "mvp anon update trip notification mutes" on public.trip_notification_mutes;
create policy "mvp anon update trip notification mutes"
on public.trip_notification_mutes
for update
to anon
using (true)
with check (true);
