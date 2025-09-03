// Minimal Geohash decode util (center point) and cell size estimate.
// Adapted for Worker use; no external deps.

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const BASE32_MAP: Record<string, number> = Object.fromEntries(
  [...BASE32].map((c, i) => [c, i])
);

export type LatLng = { lat: number; lng: number };

export function decode(geohash: string): LatLng {
  let evenBit = true;
  let latMin = -90.0,
    latMax = 90.0;
  let lonMin = -180.0,
    lonMax = 180.0;

  for (const ch of geohash.toLowerCase()) {
    const bits = BASE32_MAP[ch];
    if (bits === undefined) throw new Error(`Invalid geohash char: ${ch}`);
    for (let n = 4; n >= 0; n--) {
      const bit = (bits >> n) & 1;
      if (evenBit) {
        const lonMid = (lonMin + lonMax) / 2;
        bit ? (lonMin = lonMid) : (lonMax = lonMid);
      } else {
        const latMid = (latMin + latMax) / 2;
        bit ? (latMin = latMid) : (latMax = latMid);
      }
      evenBit = !evenBit;
    }
  }

  return {
    lat: (latMin + latMax) / 2,
    lng: (lonMin + lonMax) / 2,
  };
}

export function cellRadiusMeters(precision: number): number {
  // Approximate geohash cell width/height by precision.
  // Values approximate at equator; we return half of max dimension.
  // [precision]: [height, width] meters
  const table: Record<number, [number, number]> = {
    1: [5000000, 5000000],
    2: [1250000, 625000],
    3: [156000, 156000],
    4: [39100, 19500],
    5: [4890, 4890],
    6: [1220, 610],
    7: [153, 153],
    8: [38.2, 19.1],
    9: [4.77, 4.77],
    10: [1.19, 0.596],
  };
  const [h, w] = table[precision] ?? [153, 153];
  return Math.max(h, w) / 2;
}

