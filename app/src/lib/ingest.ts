export async function ingestHit(cellId: string, ts?: number) {
  const { signedFetch } = await import('./auth');
  const res = await signedFetch('/ingest', { cellId, ts });
  if (!res.ok) throw new Error(`Ingest failed: ${res.status}`);
  return await res.json();
}
