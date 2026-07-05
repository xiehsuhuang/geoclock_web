-- GeoClock Web V0.4 Web Push schema
-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。

create extension if not exists pgcrypto;

alter table public.trips
  add column if not exists arrival_radius_m integer not null default 100;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_code text,
  share_code text,
  role text not null default 'owner',
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.push_subscriptions
  alter column user_code drop not null,
  add column if not exists share_code text,
  add column if not exists role text not null default 'owner';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'push_subscriptions_role_check'
  ) then
    alter table public.push_subscriptions
      add constraint push_subscriptions_role_check check (role in ('owner', 'viewer'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'push_subscriptions_owner_or_share_check'
  ) then
    alter table public.push_subscriptions
      add constraint push_subscriptions_owner_or_share_check check (user_code is not null or share_code is not null);
  end if;
end $$;

create table if not exists public.wake_requests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references public.trips(id) on delete cascade,
  share_code text not null,
  from_viewer_code text,
  to_owner_code text not null,
  status text not null default 'active',
  message text,
  created_at timestamptz default now(),
  acknowledged_at timestamptz,
  stopped_at timestamptz
);

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references public.trips(id) on delete cascade,
  share_code text not null,
  event_type text not null,
  sent_at timestamptz default now(),
  unique (trip_id, event_type)
);

alter table public.push_subscriptions enable row level security;
alter table public.wake_requests enable row level security;
alter table public.notification_events enable row level security;

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon insert push subscriptions" on public.push_subscriptions;
create policy "mvp anon insert push subscriptions"
on public.push_subscriptions
for insert
to anon
with check (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon update push subscriptions" on public.push_subscriptions;
create policy "mvp anon update push subscriptions"
on public.push_subscriptions
for update
to anon
using (true)
with check (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon select push subscriptions" on public.push_subscriptions;
create policy "mvp anon select push subscriptions"
on public.push_subscriptions
for select
to anon
using (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon insert wake requests" on public.wake_requests;
create policy "mvp anon insert wake requests"
on public.wake_requests
for insert
to anon
with check (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon update wake requests" on public.wake_requests;
create policy "mvp anon update wake requests"
on public.wake_requests
for update
to anon
using (true)
with check (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon select wake requests" on public.wake_requests;
create policy "mvp anon select wake requests"
on public.wake_requests
for select
to anon
using (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon insert notification events" on public.notification_events;
create policy "mvp anon insert notification events"
on public.notification_events
for insert
to anon
with check (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon select notification events" on public.notification_events;
create policy "mvp anon select notification events"
on public.notification_events
for select
to anon
using (true);
