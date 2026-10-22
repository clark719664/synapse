export interface LayeredOptions {
  /** Horizontal gap between one depth's column block and the next. */
  columnGap: number;
  rowGap: number;
  /** A column taller than this wraps into staggered sub-columns. */
  maxRows: number;
  subColumnGap: number;
}

export const LAYERED_DEFAULTS: LayeredOptions = { columnGap: 270, rowGap: 104, maxRows: 8, subColumnGap: 210 };

interface Item {
  id: string;
  depth: number;
}

/**
 * Tidy layered placement: one column per call depth, nodes ordered within a
 * column by the barycentre of their neighbours (a few up-and-down sweeps of
 * the classic Sugiyama heuristic, which cuts edge crossings), busiest first on
 * ties. Long columns wrap into staggered sub-columns so the picture stays wide
 * rather than tall. Returns a target position per node, centred on the origin.
 */
export function layeredTargets(
  nodes: Iterable<Item>,
  edges: Iterable<{ source: string; target: string }>,
  weight: (id: string) => number,
  options: Partial<LayeredOptions> = {},
): Map<string, { x: number; y: number }> {
  const o = { ...LAYERED_DEFAULTS, ...options };
  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    let col = columns.get(n.depth);
    if (!col) columns.set(n.depth, (col = []));
    col.push(n.id);
  }
  const depths = [...columns.keys()].sort((a, b) => a - b);
  for (const d of depths) columns.get(d)!.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));

  const into = new Map<string, string[]>();
  const outOf = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    (outOf.get(e.source) ?? outOf.set(e.source, []).get(e.source)!).push(e.target);
    (into.get(e.target) ?? into.set(e.target, []).get(e.target)!).push(e.source);
  }

  const index = new Map<string, number>();
  const reindex = () => { for (const d of depths) columns.get(d)!.forEach((id, i) => index.set(id, i / Math.max(1, columns.get(d)!.length - 1))); };
  reindex();
  const sweep = (order: number[], neighbours: Map<string, string[]>) => {
    for (const d of order) {
      const col = columns.get(d)!;
      const bary = new Map<string, number>();
      col.forEach((id, i) => {
        const ns = (neighbours.get(id) ?? []).filter((n) => index.has(n));
        bary.set(id, ns.length ? ns.reduce((s, n) => s + index.get(n)!, 0) / ns.length : i / Math.max(1, col.length - 1));
      });
      // Stable sort keeps the busier node first when barycentres tie.
      col.sort((a, b) => bary.get(a)! - bary.get(b)!);
      col.forEach((id, i) => index.set(id, i / Math.max(1, col.length - 1)));
    }
  };
  for (let i = 0; i < 3; i++) {
    sweep(depths.slice(1), into);
    sweep(depths.slice(0, -1).reverse(), outOf);
  }

  const out = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const d of depths) {
    const col = columns.get(d)!;
    const subs = Math.max(1, Math.ceil(col.length / o.maxRows));
    const rows = Math.ceil(col.length / subs);
    col.forEach((id, i) => {
      const sub = i % subs;
      const row = Math.floor(i / subs);
      const stagger = subs > 1 ? (sub / subs - (subs - 1) / (2 * subs)) * o.rowGap : 0;
      out.set(id, { x: x + sub * o.subColumnGap, y: (row - (rows - 1) / 2) * o.rowGap + stagger });
    });
    x += (subs - 1) * o.subColumnGap + o.columnGap;
  }
  const width = x - o.columnGap;
  for (const p of out.values()) p.x -= width / 2;
  return out;
}
