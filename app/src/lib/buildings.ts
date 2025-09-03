import buildingsGeo from "../../assets/buildings.json";

export type Building = {
  id: string;
  name: string;
  center: { latitude: number; longitude: number };
  polygon: { latitude: number; longitude: number }[];
};

function centroid(coords: [number, number][]): { latitude: number; longitude: number } {
  // naive centroid (average of vertices) works fine for small polygons
  let sx = 0, sy = 0;
  for (const [lng, lat] of coords) {
    sx += lng; sy += lat;
  }
  const n = coords.length || 1;
  return { latitude: sy / n, longitude: sx / n };
}

export const BUILDINGS: Building[] = (buildingsGeo.features || []).map((f: any) => {
  const props = f.properties || {};
  const id: string = props.id || props.slug || props.name?.toLowerCase().replace(/\s+/g, '-') || Math.random().toString(36).slice(2);
  const name: string = props.name || id;
  let ring: [number, number][] = [];
  if (f.geometry?.type === 'Polygon') {
    ring = f.geometry.coordinates[0];
  } else if (f.geometry?.type === 'MultiPolygon') {
    ring = f.geometry.coordinates[0][0];
  }
  const center = centroid(ring);
  const polygon = ring.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  return { id, name, center, polygon } as Building;
});

function haversineMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const sinDLat = Math.sin(dLat / 2), sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function findNearestBuilding(lat: number, lng: number): Building | null {
  if (!BUILDINGS.length) return null;
  const p = { latitude: lat, longitude: lng };
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of BUILDINGS) {
    const d = haversineMeters(p, b.center);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

