import { signedFetch } from './auth';

export async function sendVibe(cellId: string, vibe: string) {
  const res = await signedFetch('/vibe', { cellId, vibe });
  if (!res.ok) throw new Error(`Vibe failed: ${res.status}`);
  return await res.json();
}

