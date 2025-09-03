# BuzzPulse — Privacy-First Campus Heat Map (Expo + Cloudflare Workers)

BuzzPulse shows live campus activity as a heat map while preserving privacy. The app samples location on-device, limits to campus zones, maps the position to a building, and sends only coarse, building‑level presence to a Cloudflare Worker. The backend aggregates active device presence and optional “vibes” to render a heat overlay.

## Highlights

- Building‑level presence (not raw GPS) with a single presence per device that “moves” between buildings
- Signed device auth: /ingest and /vibe require per‑device signatures
- Presence‑based heat (K‑anonymity via min=K) and “vibes” (👍🔥🎉😴) limited to on‑location devices
- Native iOS tabs (dev/standalone build) with safe‑area UI, blur surfaces, and haptics
- Motion‑aware sampling and hot‑cell local notifications

## Architecture

Client (Expo React Native)

- Location via `expo-location`; motion via `expo-sensors`; local alerts via `expo-notifications`
- On‑device zone filtering (campus polygons) + building mapping (polygon containment → nearest centroid)
- Device auth: registers once and signs requests (`x-device-id`, `x-timestamp`, `x-signature`)
- Map (react-native-maps) + native iOS tabs (`react-native-bottom-tabs` in dev/standalone, RN tabs in Expo Go)
- Bottom sheet for building stats: presence, last‑hour vibes, and vibe buttons

Backend (Cloudflare Workers + D1)

- Presence model: one row per device indicating its current building + last update
- Heat is derived from active presence in a recent window (default 15 minutes)
- Vibes: one per device per building per hour; must be present to react

## Data Model (D1)

```sql
-- 0001_init.sql (legacy aggregates, optional)
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

-- 0002_auth_vibes.sql
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
  device_id text,
  hour integer
);
create index if not exists idx_vibes_cell_ts on vibes(cell_id, ts);
create unique index if not exists idx_vibes_unique on vibes(cell_id, device_id, hour);

-- 0003_presence.sql
create table if not exists device_presence (
  device_id text primary key,
  cell_id text not null,
  updated_ts integer not null
);
create index if not exists idx_presence_cell on device_presence(cell_id);
```

## API

- POST `/device/register`
  - Returns `{ deviceId, secret }`. Client stores this and signs future requests.

- POST `/ingest` (signed)
  - Body: `{ cellId: string (e.g., b:<buildingId>), ts?: number }`
  - Upserts `device_presence` for the caller; returns `{ ok, cellId, ts, presence }` where `presence` is the active device count in that cell (15‑minute window).

- GET `/heat?bbox=west,south,east,north&min=K&window=minutes`
  - Returns presence‑based heat within bbox for cells with at least K active devices in the last `window` minutes.
  - Payload: `[{ lat, lng, score, radius }]` where score is presence count.

- GET `/stats?cellId=b:<id>` (signed headers optional)
  - Returns `{ currentPresence, vibesLastHour, myVibe?, ... }` for the cell. If signed headers are provided, includes whether the caller is present: `amIPresent: boolean` and `myVibe` for the current hour.

- POST `/vibe` (signed)
  - Body: `{ vibe: string }` (cellId is derived server‑side)
  - Only allowed if the device is currently present at a building; one vibe per device per building per hour (server upsert).

## Scripts (Buildings)

Fetch all building polygons inside campus zones and generate both app and worker datasets:

```bash
cd scripts && npm i
node fetch-buildings.mjs
```

Outputs:
- `app/assets/buildings.json` (FeatureCollection for client overlays + selection)
- `worker/src/locations.ts` (id → { lat, lng, name } for heat centers)

## Runbook

Cloudflare Worker

```bash
cd worker
npm i
wrangler d1 create buzzpulse_db
wrangler d1 execute buzzpulse_db --file ./migrations/0001_init.sql
wrangler d1 execute buzzpulse_db --file ./migrations/0002_auth_vibes.sql
wrangler d1 execute buzzpulse_db --file ./migrations/0003_presence.sql
wrangler d1 execute buzzpulse_db --file ./migrations/0004_vibes_unique.sql
wrangler d1 execute buzzpulse_db --file ./migrations/0005_hits_unique.sql
wrangler deploy
```

Expo App (local dev — Expo Go by default)

```bash
cd app
npm i
# Set API URL in app/app.json → expo.extra.API_BASE_URL (use your workers.dev URL)
npx expo start  # Expo Go (no login required)
```

Optional: Dev/Standalone build for native iOS tabs

```bash
cd app
npx expo prebuild -p ios
npx pod-install
npx expo run:ios --device  # or build with EAS
# EAS (requires Apple account):
NOTE: EAS/dev-client requires an Expo account. For team members without accounts, stick to Expo Go and skip this section.
```

## App UX

- Map with heat circles; tap buildings to see a sheet
- Sheet shows: current presence, last‑hour vibes, and your vibe
- Vibes are enabled only when you’re present at that building; one per hour
- “Stats for nerds” (About) toggles the on‑map status panel (pulses sent / dropped / last upload)
- Pulse auto‑starts on app launch when permission is granted

## Privacy & Rules

- No raw coordinates are stored server‑side; only building‑level presence and aggregates
- Presence is unique per device; moving updates your presence and effectively removes you from the previous building
- Heat is presence‑based and K‑anonymous (`min=K`)
- Vibes are per‑device, per‑building, per‑hour, and allowed only for on‑location devices

## Troubleshooting

- Can’t react? Ensure Pulse is running so presence is fresh; presence window is 15 minutes. The sheet shows a hint if you aren’t present yet.
- Native tabs not showing? Use a dev/standalone build; Expo Go falls back to JS tabs.
- Device testing without paid Apple account: use Xcode free provisioning (open `app/ios/app.xcworkspace`, set Signing Team & bundle id, run on device) and `npx expo start --dev-client`.
## CI/CD

GitHub Actions are included for the Worker and Android release builds.

- Worker deploy: `.github/workflows/worker-deploy.yml`
  - Triggers on pushes to `main` that touch `worker/**` (or manually via “Run workflow”).
  - Requires repository secret `CLOUDFLARE_API_TOKEN` with permissions to deploy the Worker and execute D1.
  - Optional “migrate” job (manual) applies D1 SQL files in order.

- Android release build: `.github/workflows/android-release.yml`
  - Triggers on tag pushes (e.g., `v1.0.0`) or manual dispatch.
  - Produces an AAB artifact (`app-release-bundle`).
  - Optional signing: if you add these repo secrets, the job will embed signing config:
    - `ANDROID_KEYSTORE_BASE64` (base64 of your keystore)
    - `ANDROID_KEYSTORE_PASSWORD`
    - `ANDROID_KEY_ALIAS`
    - `ANDROID_KEY_ALIAS_PASSWORD`
  - Without secrets, it still builds an unsigned AAB you can sign locally.

Notes
- Android build uses `expo prebuild` to generate the native project, then Gradle to build the release bundle.
- iOS builds are not included (they require Apple signing on macOS runners). Use Xcode or EAS locally if needed.
