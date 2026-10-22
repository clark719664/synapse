/** World-space node radius for a given throughput; shared by layout collision, both render layers and hit-testing. */
export const nodeRadius = (rate: number): number => 16 + Math.min(12, Math.sqrt(Math.max(0, rate)) * 2.2);
