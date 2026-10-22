export type RGB = readonly [number, number, number];

/** Curated hues that stay distinguishable on a dark background. */
const SERVICE_PALETTE: RGB[] = [
  [124, 196, 255], // sky
  [167, 139, 250], // violet
  [52, 211, 153],  // mint
  [251, 191, 36],  // amber
  [244, 114, 182], // pink
  [96, 165, 250],  // blue
  [45, 212, 191],  // teal
  [251, 146, 60],  // orange
  [163, 230, 53],  // lime
  [232, 121, 249], // fuchsia
  [94, 234, 212],  // aqua
  [253, 224, 71],  // yellow
];

const cache = new Map<string, RGB>();

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Stable colour per service name; the same name always gets the same hue. */
export function serviceColor(service: string): RGB {
  let c = cache.get(service);
  if (!c) {
    c = SERVICE_PALETTE[hash(service) % SERVICE_PALETTE.length]!;
    cache.set(service, c);
  }
  return c;
}

export const css = (c: RGB, alpha = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;

export const HEALTHY: RGB = [52, 211, 153];
export const WARNING: RGB = [251, 191, 36];
export const CRITICAL: RGB = [248, 113, 113];
export const OK_PARTICLE: RGB = [140, 210, 255];
export const ERROR_PARTICLE: RGB = [255, 96, 96];
export const SLOW_PARTICLE: RGB = [255, 196, 80];

export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Green below 1% errors, amber around 5%, red at 15%+. */
export function healthColor(errorRate: number): RGB {
  if (errorRate < 0.01) return HEALTHY;
  if (errorRate < 0.05) return mix(HEALTHY, WARNING, (errorRate - 0.01) / 0.04);
  return mix(WARNING, CRITICAL, (errorRate - 0.05) / 0.1);
}
