// Simple ray casting algorithm for point-in-polygon.
// point: [lng, lat]
// polygon: array of [lng, lat], closed or open (first != last ok)
export function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export type GeoJSON = any;

// Extract outer ring polygons from a GeoJSON FeatureCollection/Feature.
export function extractPolygons(geojson: GeoJSON): [number, number][][] {
  const polys: [number, number][][] = [];
  const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
  for (const f of features) {
    const g = f.geometry ?? f;
    if (!g) continue;
    if (g.type === 'Polygon') {
      const rings = g.coordinates as [number, number][][];
      if (rings[0]) polys.push(rings[0]);
    } else if (g.type === 'MultiPolygon') {
      const multi = g.coordinates as [number, number][][][];
      for (const rings of multi) if (rings[0]) polys.push(rings[0]);
    }
  }
  return polys;
}

