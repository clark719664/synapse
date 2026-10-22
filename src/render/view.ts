/** 2D camera: world → screen is `screen = (world - center) * zoom + viewport/2`. */
export class View {
  centerX = 0;
  centerY = 0;
  zoom = 1;
  width = 1;
  height = 1;
  private targetCenter: [number, number] | null = null;
  private targetZoom: number | null = null;
  /** Jump straight to fit targets instead of easing (for reduced motion). */
  instant = false;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.centerX) * this.zoom + this.width / 2, (y - this.centerY) * this.zoom + this.height / 2];
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.zoom + this.centerX, (sy - this.height / 2) / this.zoom + this.centerY];
  }

  panBy(dx: number, dy: number): void {
    this.centerX -= dx / this.zoom;
    this.centerY -= dy / this.zoom;
    this.targetCenter = null;
  }

  /** Zooms about a screen point so the world under the cursor stays put. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = Math.max(0.2, Math.min(4, this.zoom * factor));
    const [nx, ny] = this.toWorld(sx, sy);
    this.centerX += wx - nx;
    this.centerY += wy - ny;
    this.targetCenter = null;
    this.targetZoom = null;
  }

  /** Smoothly frames a world rectangle with padding (in screen pixels). */
  fit(b: { minX: number; minY: number; maxX: number; maxY: number }, padding: number | { x: number; y: number } = 80, inset: { top?: number; right?: number; bottom?: number } = {}): void {
    const px = typeof padding === 'number' ? padding : padding.x;
    const py = typeof padding === 'number' ? padding : padding.y;
    const { top = 0, right = 0, bottom = 0 } = inset;
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const zoom = Math.max(0.2, Math.min(2.5, Math.min((this.width - right - px * 2) / w, (this.height - top - bottom - py * 2) / h)));
    this.targetZoom = zoom;
    // Shift the centre so the framed graph sits clear of whatever covers the edges of the map.
    this.targetCenter = [(b.minX + b.maxX) / 2 + right / 2 / zoom, (b.minY + b.maxY) / 2 + (bottom - top) / 2 / zoom];
  }

  /** Call every frame; eases towards any pending fit target. */
  animate(): void {
    const k = this.instant ? 1 : 0.12;
    if (this.targetCenter) {
      this.centerX += (this.targetCenter[0] - this.centerX) * k;
      this.centerY += (this.targetCenter[1] - this.centerY) * k;
      if (Math.hypot(this.targetCenter[0] - this.centerX, this.targetCenter[1] - this.centerY) < 0.5) this.targetCenter = null;
    }
    if (this.targetZoom !== null) {
      this.zoom += (this.targetZoom - this.zoom) * k;
      if (Math.abs(this.targetZoom - this.zoom) < 0.001) this.targetZoom = null;
    }
  }
}
