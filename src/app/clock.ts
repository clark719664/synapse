/**
 * A clock that can run in wall-clock time (live simulation) or as a scaled,
 * pausable virtual timeline (replaying imported traces).
 */
export class VirtualClock {
  private speedValue = 1;
  private paused = false;
  private virtualAtAnchor = 0;
  private perfAtAnchor = 0;

  constructor(private readonly perf: () => number = () => performance.now()) {
    this.virtualAtAnchor = Date.now();
    this.perfAtAnchor = this.perf();
  }

  get speed(): number {
    return this.speedValue;
  }

  set speed(v: number) {
    this.anchor();
    this.speedValue = v;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    if (this.paused) return;
    this.anchor();
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.perfAtAnchor = this.perf();
    this.paused = false;
  }

  /** Jumps the virtual time without changing speed or pause state. */
  seek(virtualMs: number): void {
    this.virtualAtAnchor = virtualMs;
    this.perfAtAnchor = this.perf();
  }

  now(): number {
    if (this.paused) return this.virtualAtAnchor;
    return this.virtualAtAnchor + (this.perf() - this.perfAtAnchor) * this.speedValue;
  }

  private anchor(): void {
    this.virtualAtAnchor = this.now();
    this.perfAtAnchor = this.perf();
  }
}
