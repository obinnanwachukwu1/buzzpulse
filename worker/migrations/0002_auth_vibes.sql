create table if not exists devices (
  device_id text primary key,
  secret text not null,
  created_at integer not null,
  last_seen integer,
  disabled integer default 0
);

create table if not exists vibes (
  id integer primary key autoincrement,
  cell_id text not null,
  vibe text not null,
  ts integer not null,
  device_id text
);
create index if not exists idx_vibes_cell_ts on vibes(cell_id, ts);

