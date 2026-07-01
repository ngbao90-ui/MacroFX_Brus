// Shared scoring / classification helpers.
// Keeping this logic in one place means the renderer, the LLM-update merger,
// and the swing-detector all agree on what "hawkish" / "extreme" / etc. mean.

export function scoreColorClass(score) {
  if (score >= 7.5) return 'green';
  if (score >= 5.5) return 'yellow';
  if (score >= 4.5) return 'blue'; // neutral-ish, kept distinct from CSS 'yellow'
  return 'red';
}

export function scoreBarColor(score) {
  if (score >= 7.5) return '#4ade80';
  if (score >= 5.5) return '#facc15';
  if (score >= 4.5) return '#93c5fd';
  return '#f87171';
}

export function stanceFromScore(score) {
  if (score >= 7.5) return { label: 'Hawkish', bg: '#14532d', fg: '#bbf7d0' };
  if (score >= 5.5) return { label: 'N-Hawk', bg: '#78350f', fg: '#fef08a' };
  if (score >= 4.5) return { label: 'Neutral', bg: '#1e3a5f', fg: '#bfdbfe' };
  return { label: 'N-Dove', bg: '#7c2d12', fg: '#fed7aa' };
}

export function zClass(z) {
  if (z >= 2.0) return 'zscore-extreme-long';
  if (z >= 1.0) return 'zscore-long';
  if (z > -1.0) return 'zscore-neutral';
  if (z > -2.0) return 'zscore-short';
  return 'zscore-extreme-short';
}

export function dotsAgree(dots) {
  // returns 'up' | 'down' | null (null = no 3/3 confluence)
  if (dots.length !== 3) return null;
  if (dots.every(d => d === 'up')) return 'up';
  if (dots.every(d => d === 'down')) return 'down';
  return null;
}

export function fmtDot(dir) {
  if (dir === 'up') return { symbol: '↑', cls: 'dot-up' };
  if (dir === 'down') return { symbol: '↓', cls: 'dot-dn' };
  return { symbol: '—', cls: 'dot-nt' };
}
