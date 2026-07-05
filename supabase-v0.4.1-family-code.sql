-- GeoClock Web V0.4.1 family code connection migration
-- Keeps the no-login MVP model. Formal release should replace this with auth + owner verification.

create unique index if not exists permissions_owner_viewer_level_idx
on public.permissions (owner_code, viewer_code, permission_level);
