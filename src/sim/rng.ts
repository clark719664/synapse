/** mulberry32: tiny seeded PRNG so demo traffic is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller. */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Hex id of `bytes` bytes. */
export function hexId(rand: () => number, bytes: number): string {
  let s = '';
  for (let i = 0; i < bytes; i++) s += Math.floor(rand() * 256).toString(16).padStart(2, '0');
  return s;
}
