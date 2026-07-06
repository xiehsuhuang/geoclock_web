-- GeoClock Stable MVP schema health check.
-- MVP 無登入設計，正式版需改 Supabase Auth 與 owner 驗證。
-- Safe to run repeatedly. No table drops, data deletes, or truncation.

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  user_code text unique,
  created_at timestamptz default now()
);

alter table public.users add column if not exists display_name text;
alter table public.users add column if not exists user_code text;
alter table public.users add column if not exists created_at timestamptz default now();
create unique index if not exists idx_users_user_code_unique on public.users (user_code);

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  share_code text unique,
  owner_code text,
  destination_name text,
  destination_address text,
  destination_lat double precision,
  destination_lng double precision,
  alert_radius_m integer,
  arrival_radius_m integer default 100,
  duration_minutes integer default 120,
  expires_at timestamptz,
  status text,
  distance_m double precision,
  current_lat double precision,
  current_lng double precision,
  approximate_lat double precision,
  approximate_lng double precision,
  last_location_at timestamptz,
  started_at timestamptz default now(),
  ended_at timestamptz
);

alter table public.trips add column if not exists share_code text;
alter table public.trips add column if not exists owner_code text;
alter table public.trips add column if not exists destination_name text;
alter table public.trips add column if not exists destination_address text;
alter table public.trips add column if not exists destination_lat double precision;
alter table public.trips add column if not exists destination_lng double precision;
alter table public.trips add column if not exists alert_radius_m integer;
alter table public.trips add column if not exists arrival_radius_m integer default 100;
alter table public.trips add column if not exists duration_minutes integer default 120;
alter table public.trips add column if not exists expires_at timestamptz;
alter table public.trips add column if not exists status text;
alter table public.trips add column if not exists distance_m double precision;
alter table public.trips add column if not exists current_lat double precision;
alter table public.trips add column if not exists current_lng double precision;
alter table public.trips add column if not exists approximate_lat double precision;
alter table public.trips add column if not exists approximate_lng double precision;
alter table public.trips add column if not exists last_location_at timestamptz;
alter table public.trips add column if not exists started_at timestamptz default now();
alter table public.trips add column if not exists ended_at timestamptz;
create unique index if not exists idx_trips_share_code_unique on public.trips (share_code);
create index if not exists idx_trips_owner_active on public.trips (owner_code, ended_at, expires_at, started_at);

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  owner_code text,
  viewer_code text,
  permission_level text,
  enabled boolean default true,
  created_at timestamptz default now()
);

alter table public.permissions add column if not exists owner_code text;
alter table public.permissions add column if not exists viewer_code text;
alter table public.permissions add column if not exists permission_level text;
alter table public.permissions add column if not exists enabled boolean default true;
alter table public.permissions add column if not exists created_at timestamptz default now();
create index if not exists idx_permissions_owner_viewer on public.permissions (owner_code, viewer_code);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_code text,
  share_code text,
  role text,
  endpoint text unique,
  p256dh text,
  auth text,
  user_agent text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.push_subscriptions add column if not exists user_code text;
alter table public.push_subscriptions add column if not exists share_code text;
alter table public.push_subscriptions add column if not exists role text;
alter table public.push_subscriptions add column if not exists endpoint text;
alter table public.push_subscriptions add column if not exists p256dh text;
alter table public.push_subscriptions add column if not exists auth text;
alter table public.push_subscriptions add column if not exists user_agent text;
alter table public.push_subscriptions add column if not exists created_at timestamptz default now();
alter table public.push_subscriptions add column if not exists updated_at timestamptz default now();
create unique index if not exists idx_push_subscriptions_endpoint_unique on public.push_subscriptions (endpoint);
create index if not exists idx_push_subscriptions_user_code on public.push_subscriptions (user_code);
create index if not exists idx_push_subscriptions_share_code on public.push_subscriptions (share_code);

create table if not exists public.wake_requests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid,
  share_code text,
  from_viewer_code text,
  to_owner_code text,
  requester_code text,
  target_owner_code text,
  viewer_code text,
  owner_code text,
  message text,
  status text default 'active',
  push_count integer default 0,
  max_push_count integer default 5,
  interval_seconds integer default 3,
  last_push_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  acknowledged_at timestamptz,
  expired_at timestamptz
);

alter table public.wake_requests add column if not exists trip_id uuid;
alter table public.wake_requests add column if not exists share_code text;
alter table public.wake_requests add column if not exists from_viewer_code text;
alter table public.wake_requests add column if not exists to_owner_code text;
alter table public.wake_requests add column if not exists requester_code text;
alter table public.wake_requests add column if not exists target_owner_code text;
alter table public.wake_requests add column if not exists viewer_code text;
alter table public.wake_requests add column if not exists owner_code text;
alter table public.wake_requests add column if not exists message text;
alter table public.wake_requests add column if not exists status text default 'active';
alter table public.wake_requests add column if not exists push_count integer default 0;
alter table public.wake_requests add column if not exists max_push_count integer default 5;
alter table public.wake_requests add column if not exists interval_seconds integer default 3;
alter table public.wake_requests add column if not exists last_push_at timestamptz;
alter table public.wake_requests add column if not exists created_at timestamptz default now();
alter table public.wake_requests add column if not exists updated_at timestamptz default now();
alter table public.wake_requests add column if not exists acknowledged_at timestamptz;
alter table public.wake_requests add column if not exists expired_at timestamptz;
create index if not exists idx_wake_requests_share_status on public.wake_requests (share_code, status);
create index if not exists idx_wake_requests_owner_status on public.wake_requests (to_owner_code, status);

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid,
  share_code text,
  event_type text,
  role text,
  recipient_role text,
  recipient_code text,
  endpoint text,
  success boolean default true,
  error text,
  sent_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table public.notification_events add column if not exists trip_id uuid;
alter table public.notification_events add column if not exists share_code text;
alter table public.notification_events add column if not exists event_type text;
alter table public.notification_events add column if not exists role text;
alter table public.notification_events add column if not exists recipient_role text;
alter table public.notification_events add column if not exists recipient_code text;
alter table public.notification_events add column if not exists endpoint text;
alter table public.notification_events add column if not exists success boolean default true;
alter table public.notification_events add column if not exists error text;
alter table public.notification_events add column if not exists sent_at timestamptz default now();
alter table public.notification_events add column if not exists created_at timestamptz default now();
create index if not exists idx_notification_events_trip_event_recipient
on public.notification_events (share_code, event_type, recipient_role, recipient_code, endpoint, sent_at);

create table if not exists public.trip_notification_mutes (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid,
  share_code text,
  role text,
  user_code text,
  endpoint text,
  event_type text default 'all',
  muted boolean default true,
  created_at timestamptz default now()
);

alter table public.trip_notification_mutes add column if not exists trip_id uuid;
alter table public.trip_notification_mutes add column if not exists share_code text;
alter table public.trip_notification_mutes add column if not exists role text;
alter table public.trip_notification_mutes add column if not exists user_code text;
alter table public.trip_notification_mutes add column if not exists endpoint text;
alter table public.trip_notification_mutes add column if not exists event_type text default 'all';
alter table public.trip_notification_mutes add column if not exists muted boolean default true;
alter table public.trip_notification_mutes add column if not exists created_at timestamptz default now();
create index if not exists idx_trip_notification_mutes_lookup
on public.trip_notification_mutes (share_code, role, user_code, endpoint, event_type, muted);

create table if not exists public.family_connections (
  id uuid primary key default gen_random_uuid(),
  pair_key text unique,
  user_a_code text,
  user_b_code text,
  user_a_permissions jsonb default '{}',
  user_b_permissions jsonb default '{}',
  user_a_confirmed boolean default false,
  user_b_confirmed boolean default false,
  status text default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  confirmed_at timestamptz
);

alter table public.family_connections add column if not exists pair_key text;
alter table public.family_connections add column if not exists user_a_code text;
alter table public.family_connections add column if not exists user_b_code text;
alter table public.family_connections add column if not exists user_a_permissions jsonb default '{}';
alter table public.family_connections add column if not exists user_b_permissions jsonb default '{}';
alter table public.family_connections add column if not exists user_a_confirmed boolean default false;
alter table public.family_connections add column if not exists user_b_confirmed boolean default false;
alter table public.family_connections add column if not exists status text default 'pending';
alter table public.family_connections add column if not exists created_at timestamptz default now();
alter table public.family_connections add column if not exists updated_at timestamptz default now();
alter table public.family_connections add column if not exists confirmed_at timestamptz;
create unique index if not exists idx_family_connections_pair_key_unique on public.family_connections (pair_key);
create index if not exists idx_family_connections_user_a on public.family_connections (user_a_code);
create index if not exists idx_family_connections_user_b on public.family_connections (user_b_code);

create table if not exists public.trip_recipients (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid,
  share_code text,
  owner_code text,
  recipient_code text,
  source text default 'manual_start_selection',
  can_view boolean default true,
  can_receive_notifications boolean default true,
  created_at timestamptz default now()
);

alter table public.trip_recipients add column if not exists trip_id uuid;
alter table public.trip_recipients add column if not exists share_code text;
alter table public.trip_recipients add column if not exists owner_code text;
alter table public.trip_recipients add column if not exists recipient_code text;
alter table public.trip_recipients add column if not exists source text default 'manual_start_selection';
alter table public.trip_recipients add column if not exists can_view boolean default true;
alter table public.trip_recipients add column if not exists can_receive_notifications boolean default true;
alter table public.trip_recipients add column if not exists created_at timestamptz default now();
create index if not exists idx_trip_recipients_share_code on public.trip_recipients (share_code);
create index if not exists idx_trip_recipients_owner_recipient on public.trip_recipients (owner_code, recipient_code);
create unique index if not exists idx_trip_recipients_unique_trip_recipient on public.trip_recipients (trip_id, recipient_code);

alter table public.users enable row level security;
alter table public.trips enable row level security;
alter table public.permissions enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.wake_requests enable row level security;
alter table public.notification_events enable row level security;
alter table public.trip_notification_mutes enable row level security;
alter table public.family_connections enable row level security;
alter table public.trip_recipients enable row level security;

-- MVP 無登入設計，正式版需改 Supabase Auth 與 owner 驗證。
drop policy if exists "anon select users stable mvp" on public.users;
create policy "anon select users stable mvp" on public.users for select to anon using (true);
drop policy if exists "anon insert users stable mvp" on public.users;
create policy "anon insert users stable mvp" on public.users for insert to anon with check (true);
drop policy if exists "anon update users stable mvp" on public.users;
create policy "anon update users stable mvp" on public.users for update to anon using (true) with check (true);

drop policy if exists "anon select trips stable mvp" on public.trips;
create policy "anon select trips stable mvp" on public.trips for select to anon using (true);
drop policy if exists "anon insert trips stable mvp" on public.trips;
create policy "anon insert trips stable mvp" on public.trips for insert to anon with check (true);
drop policy if exists "anon update trips stable mvp" on public.trips;
create policy "anon update trips stable mvp" on public.trips for update to anon using (true) with check (true);

drop policy if exists "anon select permissions stable mvp" on public.permissions;
create policy "anon select permissions stable mvp" on public.permissions for select to anon using (true);
drop policy if exists "anon insert permissions stable mvp" on public.permissions;
create policy "anon insert permissions stable mvp" on public.permissions for insert to anon with check (true);
drop policy if exists "anon update permissions stable mvp" on public.permissions;
create policy "anon update permissions stable mvp" on public.permissions for update to anon using (true) with check (true);

drop policy if exists "anon select push_subscriptions stable mvp" on public.push_subscriptions;
create policy "anon select push_subscriptions stable mvp" on public.push_subscriptions for select to anon using (true);
drop policy if exists "anon insert push_subscriptions stable mvp" on public.push_subscriptions;
create policy "anon insert push_subscriptions stable mvp" on public.push_subscriptions for insert to anon with check (true);
drop policy if exists "anon update push_subscriptions stable mvp" on public.push_subscriptions;
create policy "anon update push_subscriptions stable mvp" on public.push_subscriptions for update to anon using (true) with check (true);

drop policy if exists "anon select wake_requests stable mvp" on public.wake_requests;
create policy "anon select wake_requests stable mvp" on public.wake_requests for select to anon using (true);
drop policy if exists "anon insert wake_requests stable mvp" on public.wake_requests;
create policy "anon insert wake_requests stable mvp" on public.wake_requests for insert to anon with check (true);
drop policy if exists "anon update wake_requests stable mvp" on public.wake_requests;
create policy "anon update wake_requests stable mvp" on public.wake_requests for update to anon using (true) with check (true);

drop policy if exists "anon select notification_events stable mvp" on public.notification_events;
create policy "anon select notification_events stable mvp" on public.notification_events for select to anon using (true);
drop policy if exists "anon insert notification_events stable mvp" on public.notification_events;
create policy "anon insert notification_events stable mvp" on public.notification_events for insert to anon with check (true);
drop policy if exists "anon update notification_events stable mvp" on public.notification_events;
create policy "anon update notification_events stable mvp" on public.notification_events for update to anon using (true) with check (true);

drop policy if exists "anon select trip_notification_mutes stable mvp" on public.trip_notification_mutes;
create policy "anon select trip_notification_mutes stable mvp" on public.trip_notification_mutes for select to anon using (true);
drop policy if exists "anon insert trip_notification_mutes stable mvp" on public.trip_notification_mutes;
create policy "anon insert trip_notification_mutes stable mvp" on public.trip_notification_mutes for insert to anon with check (true);
drop policy if exists "anon update trip_notification_mutes stable mvp" on public.trip_notification_mutes;
create policy "anon update trip_notification_mutes stable mvp" on public.trip_notification_mutes for update to anon using (true) with check (true);

drop policy if exists "anon select family_connections stable mvp" on public.family_connections;
create policy "anon select family_connections stable mvp" on public.family_connections for select to anon using (true);
drop policy if exists "anon insert family_connections stable mvp" on public.family_connections;
create policy "anon insert family_connections stable mvp" on public.family_connections for insert to anon with check (true);
drop policy if exists "anon update family_connections stable mvp" on public.family_connections;
create policy "anon update family_connections stable mvp" on public.family_connections for update to anon using (true) with check (true);

drop policy if exists "anon select trip_recipients stable mvp" on public.trip_recipients;
create policy "anon select trip_recipients stable mvp" on public.trip_recipients for select to anon using (true);
drop policy if exists "anon insert trip_recipients stable mvp" on public.trip_recipients;
create policy "anon insert trip_recipients stable mvp" on public.trip_recipients for insert to anon with check (true);
drop policy if exists "anon update trip_recipients stable mvp" on public.trip_recipients;
create policy "anon update trip_recipients stable mvp" on public.trip_recipients for update to anon using (true) with check (true);
