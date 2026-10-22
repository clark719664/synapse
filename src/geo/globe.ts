const RAD = Math.PI / 180;

/**
 * Orthographic camera for the globe. `lon0`/`lat0` is the point facing the
 * viewer; screen position and radius are in CSS pixels. The fragment shader
 * that draws the planet uses the inverse of exactly this rotation.
 */
export class GlobeView {
  lon0 = -30;
  lat0 = 22;
  cx = 0;
  cy = 0;
  r = 0;
  visible = false;
  /** Degrees of longitude per second while nobody is dragging. */
  spin = 3;
  private grabbedUntil = 0;

  /** Projects a lat/lon (degrees) to [screenX, screenY, depth]; depth > 0 is the visible hemisphere. */
  project(lat: number, lon: number, out: [number, number, number] = [0, 0, 0], lift = 1): [number, number, number] {
    const la = lat * RAD;
    const lo = (lon - this.lon0) * RAD;
    const t = this.lat0 * RAD;
    const x = Math.cos(la) * Math.sin(lo);
    const y = Math.sin(la);
    const z = Math.cos(la) * Math.cos(lo);
    const y2 = y * Math.cos(t) - z * Math.sin(t);
    const z2 = y * Math.sin(t) + z * Math.cos(t);
    out[0] = this.cx + x * this.r * lift;
    out[1] = this.cy - y2 * this.r * lift;
    out[2] = z2;
    return out;
  }

  contains(sx: number, sy: number): boolean {
    return this.visible && Math.hypot(sx - this.cx, sy - this.cy) <= this.r;
  }

  drag(dx: number, dy: number, nowMs: number): void {
    const k = 90 / Math.max(40, this.r);
    this.lon0 = wrap(this.lon0 - dx * k);
    this.lat0 = Math.max(-70, Math.min(70, this.lat0 + dy * k));
    this.grabbedUntil = nowMs + 4000;
  }

  /** Slow auto-rotation, paused for a moment after the user drags. */
  advance(dtMs: number, nowMs: number, enabled: boolean): void {
    if (!enabled || nowMs < this.grabbedUntil) return;
    this.lon0 = wrap(this.lon0 + (this.spin * dtMs) / 1000);
  }
}

const wrap = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;
