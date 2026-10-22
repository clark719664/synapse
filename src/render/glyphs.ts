import { EDITOR_NODES, OTHER_WIKIS, STREAM_NODE } from '../live/wikimedia';
import { EXTERNAL_SERVICES, INFRA_SERVICES } from '../sim/topology';

export type Glyph = 'store' | 'external' | 'person' | 'anon' | 'bot' | 'globe' | 'stream' | 'dot';

export function glyphFor(id: string): Glyph {
  if (INFRA_SERVICES.has(id)) return 'store';
  if (EXTERNAL_SERVICES.has(id)) return 'external';
  if (id === STREAM_NODE) return 'stream';
  if (id === OTHER_WIKIS || /\.(org|com|net)$/.test(id)) return 'globe';
  if ((EDITOR_NODES as readonly string[]).includes(id)) return id === 'bots' ? 'bot' : id === 'anonymous' ? 'anon' : 'person';
  return 'dot';
}

/** Strokes a small icon centred on (x, y) scaled to a node of radius r. Caller sets stroke/fill style. */
export function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, x: number, y: number, r: number): void {
  const s = r * 0.42;
  ctx.beginPath();
  switch (glyph) {
    case 'store':
      ctx.ellipse(x, y - s * 0.55, s, s * 0.38, 0, 0, Math.PI * 2);
      ctx.moveTo(x - s, y - s * 0.55);
      ctx.lineTo(x - s, y + s * 0.6);
      ctx.ellipse(x, y + s * 0.6, s, s * 0.38, 0, Math.PI, 0, true);
      ctx.lineTo(x + s, y - s * 0.55);
      ctx.stroke();
      break;
    case 'external':
      ctx.moveTo(x - s * 0.8, y + s * 0.8);
      ctx.lineTo(x + s * 0.8, y - s * 0.8);
      ctx.moveTo(x - s * 0.1, y - s * 0.8);
      ctx.lineTo(x + s * 0.8, y - s * 0.8);
      ctx.lineTo(x + s * 0.8, y + s * 0.1);
      ctx.stroke();
      break;
    case 'person':
    case 'anon':
      ctx.arc(x, y - s * 0.45, s * 0.42, 0, Math.PI * 2);
      ctx.moveTo(x + s * 0.85, y + s * 0.95);
      ctx.arc(x, y + s * 0.95, s * 0.85, 0, Math.PI, true);
      if (glyph === 'anon') {
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - s * 0.62, y - s * 0.5);
        ctx.lineTo(x + s * 0.62, y - s * 0.5);
      }
      ctx.stroke();
      break;
    case 'bot':
      ctx.roundRect(x - s * 0.8, y - s * 0.45, s * 1.6, s * 1.2, s * 0.25);
      ctx.moveTo(x, y - s * 0.45);
      ctx.lineTo(x, y - s * 0.9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x - s * 0.35, y + s * 0.12, s * 0.14, 0, Math.PI * 2);
      ctx.arc(x + s * 0.35, y + s * 0.12, s * 0.14, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'globe':
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.moveTo(x, y - s);
      ctx.ellipse(x, y, s * 0.42, s, 0, -Math.PI / 2, Math.PI * 1.5);
      ctx.moveTo(x - s, y);
      ctx.lineTo(x + s, y);
      ctx.stroke();
      break;
    case 'stream':
      for (const dy of [-0.5, 0, 0.5]) {
        ctx.moveTo(x - s, y + dy * s);
        ctx.bezierCurveTo(x - s * 0.4, y + dy * s - s * 0.35, x + s * 0.2, y + dy * s + s * 0.35, x + s, y + dy * s);
      }
      ctx.stroke();
      break;
    case 'dot':
      ctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
}
