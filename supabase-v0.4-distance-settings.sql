-- GeoClock Web distance settings migration
-- Adds a separate arrival radius so 100 m is only the default arrival threshold,
-- not the main near-destination alert distance.

alter table public.trips
  add column if not exists arrival_radius_m integer not null default 100;
