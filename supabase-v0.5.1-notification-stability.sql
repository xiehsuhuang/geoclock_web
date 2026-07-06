-- GeoClock Web V0.5.1 notification stability
-- Adds recipient metadata so Web Push can enforce per-recipient cooldowns.

alter table public.notification_events
  add column if not exists recipient_role text;

alter table public.notification_events
  add column if not exists recipient_code text;

alter table public.notification_events
  add column if not exists endpoint text;

alter table public.notification_events
  add column if not exists success boolean default true;

alter table public.notification_events
  add column if not exists error text;

create index if not exists idx_notification_events_trip_event_recipient
on public.notification_events (share_code, event_type, recipient_role, recipient_code, endpoint, sent_at);
