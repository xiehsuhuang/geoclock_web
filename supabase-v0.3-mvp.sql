-- GeoClock Web V0.3 Supabase schema
-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。

create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  user_code text unique not null,
  created_at timestamptz default now()
);

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  share_code text unique not null,
  owner_code text not null,
  destination_name text not null,
  destination_address text,
  destination_lat double precision not null,
  destination_lng double precision not null,
  alert_radius_m integer not null,
  arrival_radius_m integer not null default 100,
  status text not null,
  distance_m double precision,
  current_lat double precision,
  current_lng double precision,
  approximate_lat double precision,
  approximate_lng double precision,
  last_location_at timestamptz,
  started_at timestamptz default now(),
  ended_at timestamptz
);

alter table public.trips
  add column if not exists arrival_radius_m integer not null default 100;

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  owner_code text not null,
  viewer_code text not null,
  permission_level text not null,
  enabled boolean default true,
  created_at timestamptz default now()
);

alter table public.users enable row level security;
alter table public.trips enable row level security;
alter table public.permissions enable row level security;

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon insert users" on public.users;
create policy "mvp anon insert users"
on public.users
for insert
to anon
with check (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon insert trips" on public.trips;
create policy "mvp anon insert trips"
on public.trips
for insert
to anon
with check (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon update trips" on public.trips;
create policy "mvp anon update trips"
on public.trips
for update
to anon
using (true)
with check (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon select trips by share code" on public.trips;
create policy "mvp anon select trips by share code"
on public.trips
for select
to anon
using (true);

-- 這是無登入 MVP 權限設計，之後正式版需要改成登入與 owner 驗證。
drop policy if exists "mvp anon insert permissions" on public.permissions;
create policy "mvp anon insert permissions"
on public.permissions
for insert
to anon
with check (true);
