type VibeCounts = Record<string, number>;

export function getTopVibe(vibesLastHour?: VibeCounts | null): [string, number] | null {
  if (!vibesLastHour || typeof vibesLastHour !== 'object') return null;
  let best: [string, number] | null = null;
  for (const [emoji, count] of Object.entries(vibesLastHour)) {
    const c = Number(count) || 0;
    if (!best || c > best[1]) best = [emoji, c];
  }
  return best;
}

export function formatShare(opts: {
  name: string;
  currentPresence?: number;
  lastHourHits?: number;
  topVibe?: string | null;
  link?: string;
}): string {
  const { name, currentPresence = 0, lastHourHits = 0, topVibe, link } = opts;
  const vibePart = topVibe ? ` ${topVibe}` : '';
  const line = `${name} — ${currentPresence} here now, ${lastHourHits} in last hour${vibePart}`;
  return link ? `${line}\n${link}` : line;
}

