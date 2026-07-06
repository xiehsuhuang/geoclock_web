-- GeoClock Web V0.6.1 trip lifetime and selected recipients.
-- This is still an anonymous MVP policy design. Production should replace it with login and owner/viewer verification.

alter table public.trips
  add column if not exists expires_at timestamptz;

alter table public.trips
  add column if not exists duration_minutes integer not null default 120;

create table if not exists public.trip_recipients (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references public.trips(id) on delete cascade,
  share_code text not null,
  owner_code text not null,
  recipient_code text not null,
  source text not null default 'manual_start_selection',
  can_view boolean not null default true,
  can_receive_notifications boolean not null default true,
  created_at timestamptz default now()
);

create index if not exists idx_trip_recipients_share_code
on public.trip_recipients (share_code);

create index if not exists idx_trip_recipients_owner_recipient
on public.trip_recipients (owner_code, recipient_code);

create unique index if not exists idx_trip_recipients_unique_trip_recipient
on public.trip_recipients (trip_id, recipient_code);

alter table public.trip_recipients enable row level security;

drop policy if exists "anon can select trip_recipients mvp" on public.trip_recipients;
create policy "anon can select trip_recipients mvp"
on public.trip_recipients for select
to anon
using (true);

drop policy if exists "anon can insert trip_recipients mvp" on public.trip_recipients;
create policy "anon can insert trip_recipients mvp"
on public.trip_recipients for insert
to anon
with check (true);

drop policy if exists "anon can update trip_recipients mvp" on public.trip_recipients;
create policy "anon can update trip_recipients mvp"
on public.trip_recipients for update
to anon
using (true)
with check (true);
