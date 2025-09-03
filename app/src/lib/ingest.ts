import Constants from "expo-constants";

const API_BASE_URL: string = (Constants.expoConfig?.extra as any)?.API_BASE_URL || "http://127.0.0.1:8787";

export async function ingestHit(cellId: string, ts?: number) {
  const res = await fetch(`${API_BASE_URL}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cellId, ts }),
  });
  if (!res.ok) throw new Error(`Ingest failed: ${res.status}`);
  return await res.json();
}

