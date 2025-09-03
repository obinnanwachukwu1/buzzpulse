create table if not exists cells (
  cell_id text primary key,
  last_ts integer,
  score real default 0
);

create table if not exists hits (
  id integer primary key autoincrement,
  cell_id text not null,
  ts integer not null
);
create index if not exists idx_hits_cell_ts on hits(cell_id, ts);

