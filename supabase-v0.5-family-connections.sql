-- GeoClock Web V0.5 family connections
-- 這是無登入 MVP 權限設計，正式版之後要改成登入與 owner 驗證。

create table if not exists public.family_connections (
  id uuid primary key default gen_random_uuid(),
  pair_key text unique not null,
  user_a_code text not null,
  user_b_code text not null,
  user_a_permissions jsonb not null default '{}'::jsonb,
  user_b_permissions jsonb not null default '{}'::jsonb,
  user_a_confirmed boolean not null default false,
  user_b_confirmed boolean not null default false,
  status text not null default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  confirmed_at timestamptz
);

alter table public.push_subscriptions
  add column if not exists user_code text;

create index if not exists idx_family_connections_user_a
on public.family_connections (user_a_code);

create index if not exists idx_family_connections_user_b
on public.family_connections (user_b_code);

create index if not exists idx_family_connections_status
on public.family_connections (status);

create index if not exists idx_push_subscriptions_user_code
on public.push_subscriptions (user_code);

alter table public.family_connections enable row level security;

drop policy if exists "mvp anon select family connections" on public.family_connections;
create policy "mvp anon select family connections"
on public.family_connections
for select
to anon
using (true);

drop policy if exists "mvp anon insert family connections" on public.family_connections;
create policy "mvp anon insert family connections"
on public.family_connections
for insert
to anon
with check (true);

drop policy if exists "mvp anon update family connections" on public.family_connections;
create policy "mvp anon update family connections"
on public.family_connections
for update
to anon
using (true)
with check (true);
