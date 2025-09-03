// Minimal building locations for the Worker to map building IDs to coordinates.
// id: { lat, lng, name }
export const BUILDINGS: Record<string, { lat: number; lng: number; name: string }> = {
  'eng-quad': { lat: 37.42805, lng: -122.1723, name: 'Engineering Quad' },
  'main-quad': { lat: 37.42745, lng: -122.1701, name: 'Main Quad' },
};

