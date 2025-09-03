create table if not exists device_presence (
  device_id text primary key,
  cell_id text not null,
  updated_ts integer not null
);
create index if not exists idx_presence_cell on device_presence(cell_id);

