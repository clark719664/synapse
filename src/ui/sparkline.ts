/** Tiny inline SVG sparkline; returns a path string for `values` in a w×h box. */
export function sparklinePath(values: readonly number[], w: number, h: number, max?: number): string {
  if (values.length === 0) return '';
  const m = max ?? Math.max(1e-9, ...values);
  const step = w / Math.max(1, values.length - 1);
  let d = '';
  values.forEach((v, i) => {
    const x = i * step;
    const y = h - (Math.min(v, m) / m) * (h - 2) - 1;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return d;
}
