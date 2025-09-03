import Constants from "expo-constants";
import { signedGet } from './auth';

export type HeatPoint = {
  lat: number;
  lng: number;
  score: number;
  radius: number; // meters
};

const API_BASE_URL: string = (Constants.expoConfig?.extra as any)?.API_BASE_URL || "http://127.0.0.1:8787";

export async function fetchHeat(bbox: [number, number, number, number], opts?: { min?: number; window?: number }) {
  const [west, south, east, north] = bbox;
  const params = new URLSearchParams({
    bbox: `${west},${south},${east},${north}`,
    min: String(opts?.min ?? 1),
    window: String(opts?.window ?? 30),
  });
  const res = await fetch(`${API_BASE_URL}/heat?${params.toString()}`);
  if (!res.ok) throw new Error(`Heat fetch failed: ${res.status}`);
  const json = await res.json();
  return (json?.data ?? []) as HeatPoint[];
}

export async function fetchStats(cellId: string) {
  const res = await signedGet(`/stats?cellId=${encodeURIComponent(cellId)}`);
  if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
  return await res.json();
}
