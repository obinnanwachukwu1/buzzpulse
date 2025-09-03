import { decode as decodeGeohash, cellRadiusMeters } from "./geohash";
import { BUILDINGS } from "./locations";

interface Env {
  DB: D1Database;
}

type IngestBody = { cellId: string; ts?: number };

const HALF_LIFE_HOURS = 6; // tweakable
const HALF_LIFE_SECONDS = HALF_LIFE_HOURS * 3600;
const TAU = HALF_LIFE_SECONDS / Math.log(2); // e^(-t/TAU) == 0.5 after half-life

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/ingest") {
        return await handleIngest(req, env);
      }
      if (req.method === "GET" && url.pathname === "/heat") {
        return await handleHeat(url, env);
      }
      if (req.method === "GET" && url.pathname === "/stats") {
        return await handleStats(url, env);
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
  const body = (await req.json().catch(() => ({}))) as Partial<IngestBody>;
  const cellId = String(body.cellId || "").trim();
  if (!cellId) return json({ ok: false, error: "Missing cellId" }, 400);
  // Accept geohash (5-12) or building id with prefix b:slug
  const isGeohash = /^[0-9b-hjkmnp-z]{5,12}$/i.test(cellId);
  const isBuilding = /^b:[a-z0-9_-]+$/i.test(cellId);
  if (!isGeohash && !isBuilding) return json({ ok: false, error: "Invalid cellId" }, 400);

  const nowSec = Math.floor(Date.now() / 1000);
  const ts = Number.isFinite(body.ts) && typeof body.ts === "number" ? Math.floor(body.ts!) : nowSec;

  // Get prior state
  const prior = await env.DB.prepare(
    "select score, last_ts from cells where cell_id = ?"
  )
    .bind(cellId)
    .first<{ score: number | null; last_ts: number | null }>();

  let score = 0;
  if (!prior) {
    score = 1;
    await env.DB.prepare("insert into cells (cell_id, last_ts, score) values (?, ?, ?)")
      .bind(cellId, ts, score)
      .run();
  } else {
    const prevScore = prior.score ?? 0;
    const prevTs = prior.last_ts ?? ts;
    const dt = Math.max(0, ts - prevTs);
    const decayed = prevScore * Math.exp(-dt / TAU);
    score = decayed + 1;
    await env.DB.prepare("update cells set last_ts = ?, score = ? where cell_id = ?")
      .bind(ts, score, cellId)
      .run();
  }

  // Record hit for k-anonymity (optional)
  await env.DB.prepare("insert into hits (cell_id, ts) values (?, ?)").bind(cellId, ts).run();

  return json({ ok: true, cellId, ts, score });
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

  // Filter by recent hits count >= K; score > 0
  const stmt = env.DB.prepare(
    `select c.cell_id as cell_id, c.score as score
     from cells c
     where c.score > 0
       and (select count(*) from hits h where h.cell_id = c.cell_id and h.ts >= ?) >= ?`
  ).bind(since, minK);

  const rows = await stmt.all<{ cell_id: string; score: number }>();
  const items = (rows.results || [])
    .map((r) => toHeatPoint(r.cell_id, r.score))
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

async function handleStats(url: URL, env: Env): Promise<Response> {
  const cellId = url.searchParams.get('cellId') || '';
  if (!cellId) return json({ ok: false, error: 'Missing cellId' }, 400);

  const nowSec = Math.floor(Date.now() / 1000);
  const oneHourAgo = nowSec - 3600;
  const sevenDaysAgo = nowSec - 7 * 86400;

  const cell = await env.DB.prepare('select score as currentScore, last_ts as lastTs from cells where cell_id=?')
    .bind(cellId).first<{ currentScore: number; lastTs: number }>();

  const lastHour = await env.DB.prepare('select count(*) as cnt from hits where cell_id=? and ts>=?')
    .bind(cellId, oneHourAgo).first<{ cnt: number }>();

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

  const resp: any = {
    ok: true,
    cellId,
    type,
    name,
    currentScore: cell?.currentScore ?? 0,
    lastTs: cell?.lastTs ?? null,
    lastHourHits: lastHour?.cnt ?? 0,
    typicalHourAvgHits7d: typical?.avgCnt ?? 0,
  };
  resp.deltaVsTypical = (resp.lastHourHits ?? 0) - (resp.typicalHourAvgHits7d ?? 0);
  return json(resp);
}
