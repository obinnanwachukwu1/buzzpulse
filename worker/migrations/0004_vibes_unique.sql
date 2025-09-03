alter table vibes add column hour integer;
create unique index if not exists idx_vibes_unique on vibes(cell_id, device_id, hour);

