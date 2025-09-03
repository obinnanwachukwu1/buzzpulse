alter table hits add column device_id text;
alter table hits add column hour integer;
create unique index if not exists idx_hits_unique on hits(cell_id, device_id, hour);

