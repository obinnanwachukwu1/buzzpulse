import { decode as decodeGeohash, cellRadiusMeters } from "./geohash";
import { BUILDINGS } from "./locations";

interface Env {
  DB: D1Database;
}

type IngestBody = { cellId: string; ts?: number };

// Presence window (seconds) to consider a device "active"
const PRESENCE_WINDOW_SEC = 10 * 60; // 10 minutes

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/device/register") {
        return await handleDeviceRegister(env);
      }
      if (req.method === "POST" && url.pathname === "/vibe") {
        return await handleVibe(req, env);
      }
      if (req.method === "POST" && url.pathname === "/ingest") {
        return await handleIngest(req, env);
      }
      if (req.method === "GET" && url.pathname === "/heat") {
        return await handleHeat(url, env);
      }
      if (req.method === "GET" && url.pathname === "/stats") {
        return await handleStats(req, url, env);
      }
      if (url.pathname === "/health") {
        return json({ ok: true, service: "buzzpulse" });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleIngest(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  const deviceId = await requireAuth(req.headers, raw, env);
  const body = (JSON.parse(raw || "{}")) as Partial<IngestBody>;
  const cellId = String(body.cellId || "").trim();
  if (!cellId) return json({ ok: false, error: "Missing cellId" }, 400);
  const isGeohash = /^[0-9b-hjkmnp-z]{5,12}$/i.test(cellId);
  const isBuilding = /^b:[a-z0-9_-]+$/i.test(cellId);
  if (!isGeohash && !isBuilding) return json({ ok: false, error: "Invalid cellId" }, 400);

  const nowSec = Math.floor(Date.now() / 1000);
  const ts = Number.isFinite(body.ts) && typeof body.ts === "number" ? Math.floor(body.ts!) : nowSec;

  // Upsert device presence
  const prior = await env.DB.prepare('select cell_id from device_presence where device_id=?').bind(deviceId).first<{ cell_id: string }>();
  if (!prior) {
    await env.DB.prepare('insert into device_presence (device_id, cell_id, updated_ts) values (?, ?, ?)')
      .bind(deviceId, cellId, ts).run();
  } else if (prior.cell_id !== cellId) {
    await env.DB.prepare('update device_presence set cell_id=?, updated_ts=? where device_id=?')
      .bind(cellId, ts, deviceId).run();
  } else {
    await env.DB.prepare('update device_presence set updated_ts=? where device_id=?')
      .bind(ts, deviceId).run();
  }

  // Compute current presence count for cell within window
  const since = nowSec - PRESENCE_WINDOW_SEC;
  const row = await env.DB.prepare('select count(*) as c from device_presence where cell_id=? and updated_ts>=?')
    .bind(cellId, since).first<{ c: number }>();
  const presence = row?.c ?? 0;

  return json({ ok: true, cellId, ts, presence });
}

async function handleHeat(url: URL, env: Env): Promise<Response> {
  const bboxParam = url.searchParams.get("bbox");
  const minParam = url.searchParams.get("min");
  const windowParam = url.searchParams.get("window");
  if (!bboxParam) return json({ ok: false, error: "Missing bbox" }, 400);
  const parts = bboxParam.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return json({ ok: false, error: "Invalid bbox format" }, 400);
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  const minK = Math.max(1, parseInt(minParam || "1", 10));
  const windowMinutes = Math.max(1, parseInt(windowParam || "30", 10));
  const nowSec = Math.floor(Date.now() / 1000);
  const since = nowSec - windowMinutes * 60;

  // Presence-based heat: group active devices by cell
  const stmt = env.DB.prepare(
    `select cell_id, count(*) as c
     from device_presence
     where updated_ts >= ?
     group by cell_id
     having c >= ?`
  ).bind(since, minK);

  const rows = await stmt.all<{ cell_id: string; c: number }>();
  const items = (rows.results || [])
    .map((r) => toHeatPoint(r.cell_id, r.c))
    .filter(Boolean) as Array<{ cellId: string; lat: number; lng: number; score: number; radius: number }>;

  // BBox filter in Worker (coarse, but OK for MVP)
  const filtered = items.filter((p) =>
    p.lng >= west && p.lng <= east && p.lat >= south && p.lat <= north
  );

  // Hide cellId in response by default (privacy); include if debug=1
  const debug = url.searchParams.get("debug") === "1";
  const payload = filtered.map((p) =>
    debug ? p : { lat: p.lat, lng: p.lng, score: p.score, radius: p.radius }
  );

  return json({ ok: true, count: payload.length, data: payload });
}

function toHeatPoint(cellId: string, score: number) {
  // If building id, look up location; else decode geohash
  if (/^b:[a-z0-9_-]+$/i.test(cellId)) {
    const id = cellId.slice(2);
    const b = BUILDINGS[id];
    if (!b) return null;
    // Fixed building radius (smaller for building-centric heat)
    const radius = 25; // meters
    return { cellId, lat: b.lat, lng: b.lng, score, radius };
  }
  try {
    const { lat, lng } = decodeGeohash(cellId);
    const radius = cellRadiusMeters(cellId.length);
    return { cellId, lat, lng, score, radius };
  } catch {
    return null;
  }
}


function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleStats(req: Request, url: URL, env: Env): Promise<Response> {
  const cellId = url.searchParams.get('cellId') || '';
  if (!cellId) return json({ ok: false, error: 'Missing cellId' }, 400);

  const nowSec = Math.floor(Date.now() / 1000);
  const oneHourAgo = nowSec - 3600;
  const sevenDaysAgo = nowSec - 7 * 86400;

  const cell = await env.DB.prepare('select score as currentScore, last_ts as lastTs from cells where cell_id=?')
    .bind(cellId).first<{ currentScore: number; lastTs: number }>();

  const lastHour = await env.DB.prepare('select count(*) as cnt from hits where cell_id=? and ts>=?')
    .bind(cellId, oneHourAgo).first<{ cnt: number }>();
  const vibesRows = await env.DB.prepare('select vibe, count(*) as c from vibes where cell_id=? and ts>=? group by vibe')
    .bind(cellId, oneHourAgo).all<{ vibe: string; c: number }>();
  const vibesLastHour: Record<string, number> = {};
  for (const r of vibesRows.results ?? []) vibesLastHour[r.vibe] = Number(r.c || 0);

  // Typical: average count across past 7 days for current hour-of-day
  const hourStr = new Date(nowSec * 1000).toISOString().substring(11, 13); // UTC hour
  const typical = await env.DB.prepare(
    `with hourly as (
       select date(ts, 'unixepoch') as d, count(*) as cnt
       from hits
       where cell_id=? and ts>=?
         and strftime('%H', ts, 'unixepoch') = ?
       group by d
     )
     select avg(cnt) as avgCnt from hourly`
  ).bind(cellId, sevenDaysAgo, hourStr).first<{ avgCnt: number | null }>();

  let type = 'cell';
  let name: string | undefined;
  if (/^b:[a-z0-9_-]+$/i.test(cellId)) {
    type = 'building';
    const id = cellId.slice(2);
    name = BUILDINGS[id]?.name;
  }

  // Current active presence for this cell
  const presenceRow = await env.DB.prepare('select count(*) as c from device_presence where cell_id=? and updated_ts>=?')
    .bind(cellId, nowSec - PRESENCE_WINDOW_SEC).first<{ c: number }>();

  // Optional: include myVibe if signed headers present
  const myId = await requireAuthOptional(req.headers, env);
  let myVibe: string | undefined;
  if (myId) {
    const hour = nowSec - (nowSec % 3600);
    const mv = await env.DB.prepare('select vibe from vibes where cell_id=? and device_id=? and hour=?')
      .bind(cellId, myId, hour).first<{ vibe: string }>();
    myVibe = mv?.vibe;
  }

  const resp: any = {
    ok: true,
    cellId,
    type,
    name,
    currentScore: cell?.currentScore ?? 0,
    lastTs: cell?.lastTs ?? null,
    lastHourHits: lastHour?.cnt ?? 0,
    typicalHourAvgHits7d: typical?.avgCnt ?? 0,
    vibesLastHour,
    currentPresence: presenceRow?.c ?? 0,
    myVibe,
  };
  resp.deltaVsTypical = (resp.lastHourHits ?? 0) - (resp.typicalHourAvgHits7d ?? 0);
  return json(resp);
}

async function handleDeviceRegister(env: Env): Promise<Response> {
  const deviceId = crypto.randomUUID();
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = b64(secretBytes);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('insert into devices (device_id, secret, created_at, last_seen) values (?, ?, ?, ?)')
    .bind(deviceId, secret, now, now).run();
  return json({ ok: true, deviceId, secret });
}

async function handleVibe(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  const deviceId = await requireAuth(req.headers, raw, env);
  const body = JSON.parse(raw || '{}') as { cellId?: string; vibe?: string; ts?: number };
  let cellId = (body.cellId || '').trim();
  const vibe = (body.vibe || '').trim();
  if (!cellId || !vibe) return json({ ok: false, error: 'Missing cellId or vibe' }, 400);
  const ts = Number.isFinite(body.ts) ? Math.floor(Number(body.ts)) : Math.floor(Date.now() / 1000);
  // Must be currently present; derive building from presence, do not trust client cellId
  const present = await env.DB.prepare('select cell_id from device_presence where device_id=? and updated_ts>=?')
    .bind(deviceId, ts - PRESENCE_WINDOW_SEC)
    .first<{ cell_id: string }>();
  if (!present) return json({ ok: false, error: 'Not present' }, 403);
  cellId = present.cell_id;
  // Only allow building vibes
  if (!/^b:[a-z0-9_-]+$/i.test(cellId)) return json({ ok: false, error: 'Vibes only allowed for buildings' }, 400);
  const hour = ts - (ts % 3600);
  await env.DB.prepare('insert into vibes (cell_id, vibe, ts, device_id, hour) values (?, ?, ?, ?, ?) on conflict(cell_id, device_id, hour) do update set vibe=excluded.vibe, ts=excluded.ts')
    .bind(cellId, vibe, ts, deviceId, hour).run();
  return json({ ok: true, cellId, vibe });
}

async function requireAuth(h: Headers, body: string, env: Env): Promise<string> {
  const id = h.get('x-device-id') || '';
  const sig = (h.get('x-signature') || '').toLowerCase();
  const tsStr = h.get('x-timestamp') || '';
  const ts = parseInt(tsStr, 10);
  if (!id || !sig || !Number.isFinite(ts)) throw new Error('Unauthorized');
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) throw new Error('Stale signature');
  const row = await env.DB.prepare('select secret, disabled from devices where device_id=?').bind(id).first<{ secret: string; disabled: number }>();
  if (!row || row.disabled) throw new Error('Unauthorized');
  const check = await sha256Hex(`${id}.${ts}.${body}.${row.secret}`);
  if (check !== sig) throw new Error('Unauthorized');
  await env.DB.prepare('update devices set last_seen=? where device_id=?').bind(now, id).run();
  return id;
}

async function requireAuthOptional(h: Headers, env: Env): Promise<string | undefined> {
  const id = h.get('x-device-id') || '';
  const sig = (h.get('x-signature') || '').toLowerCase();
  const tsStr = h.get('x-timestamp') || '';
  const ts = parseInt(tsStr, 10);
  if (!id || !sig || !Number.isFinite(ts)) return undefined;
  try {
    await requireAuth(h, '', env);
    return id;
  } catch {
    return undefined;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(input));
  const b = new Uint8Array(hash);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
