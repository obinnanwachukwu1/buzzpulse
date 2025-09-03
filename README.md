# BuzzPulse — Privacy-First Campus Heat Map

BuzzPulse is a privacy-first campus activity heat map. Your phone samples location in the background (or foreground fallback), filters out residential areas, coarsens to ~150 m cells, and sends only cell hits to a Cloudflare Worker. The Worker aggregates into a decayed “heat score” you can render on a map.

## Status

- Worker: scaffolding in progress (`/ingest`, `/heat`)
- App: scaffolding planned (Map screen → circles)
- D1: schema defined; wiring via `wrangler.toml`

## Architecture Overview

Client (Expo React Native)

- `expo-location` + (for background) `expo-task-manager` in an EAS dev/standalone build.
- On-device residential mask (GeoJSON polygons) → drop any residential points.
- Coarsen GPS to geohash (precision ~7 ≈ 150 m) → send `{cellId, ts}`.
- Foreground map screen (react-native-maps) pulls `/heat` and draws circles.
- Offline queue + retry (simple in-memory/AsyncStorage).

Backend (Cloudflare Workers + D1)

- `POST /ingest`: time-decay update per `cellId` (never store raw lat/lng).
- `GET /heat`: return `{lat,lng,score,radius}` for cells in map bbox (server decodes geohash center).
- Optional: `/stats`, `/cells/export`.

Privacy

- Never transmit precise coordinates.
- k-anonymity threshold: don’t return a cell unless ≥K hits in last X minutes (e.g., K=3, X=30).

## Data Model (D1)

```sql
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
```

> You can disable `hits` in production if you only want aggregates.

## API Surface

- POST `/ingest` `{ cellId: string, ts?: number }`
  - Decay then add: `score = score * exp(-(ts - last_ts)/τ) + 1`, `last_ts = ts`.
  - τ (half-life): start with 6 hours (feels “live” across a day).

- GET `/heat?bbox=west,south,east,north&min=K&window=minutes`
  - Return cells within bbox with `score>0` and `hits ≥ K` in the recent window.
  - Payload: `[{ lat, lng, score, radius }]` (server decodes geohash center).

`worker/wrangler.toml`

```toml
name = "buzzpulse"
main = "src/index.ts"
compatibility_date = "2025-09-02"

[[d1_databases]]
binding = "DB"
database_name = "buzzpulse_db"
database_id = "REPLACE_ME"
```

## App UX (3 screens)

1. Map (Home)
   - Map centered on campus; heat circles overlay.
   - Top-right: Privacy chip (shows “Public spaces only”).
   - Bottom sheet: legend + “Last updated” + Refresh.
2. Pulse (Controls)
   - Big toggle: Start/Stop Pulse.
   - Status: sampling interval, last upload, cells sent.
   - Foreground mode switch (for Expo Go fallback).
3. About/Privacy
   - What we collect (cell IDs, not lat/lng), residential exclusion, k-anonymity.
   - Kill switch & data deletion note.

## Runbook

Cloudflare

```bash
cd worker
pnpm i # or npm i
wrangler d1 create buzzpulse_db
wrangler d1 execute buzzpulse_db --file ./migrations/0001_init.sql
wrangler dev
wrangler deploy
```

Expo

```bash
cd app
pnpm i # or npm i
npx expo start
# For background:
npx eas build:configure
npx eas build --profile development --platform ios|android
```

## Collaboration Plan

- Client PRs: heat legend + radius slider; dev mock pin; offline queue; i18n; dark mode polish.
- Server PRs: k-anonymity in `/heat`; `/stats`; `/cells/export.csv`.

## Risks & Fallbacks

- Can’t ship EAS? Use Foreground Pulse.
- Map API hiccups? Start with a list of nearby heat.
- Missing residential polygons? Fence to campus polygon; document partial filtering.

