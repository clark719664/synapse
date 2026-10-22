/**
 * Incidents the demo can inject. Each one perturbs latency, error rate or
 * traffic for specific services; the generator consults `modifiers()` per call.
 */
export interface ServiceModifier {
  latencyMultiplier: number;
  extraErrorRate: number;
}

export interface Scenario {
  id: string;
  label: string;
  description: string;
  trafficMultiplier: number;
  modifier: (service: string) => ServiceModifier | null;
}

const only = (services: string[], mod: ServiceModifier) => (service: string) => (services.includes(service) ? mod : null);

export const SCENARIOS: Scenario[] = [
  {
    id: 'payments-slow',
    label: 'Payments degraded',
    description: 'Stripe is timing out; payments latency ×8 and 12% of charges fail.',
    trafficMultiplier: 1,
    modifier: only(['stripe'], { latencyMultiplier: 8, extraErrorRate: 0.12 }),
  },
  {
    id: 'redis-down',
    label: 'Cache outage',
    description: 'Redis is refusing connections. Every cache call errors out.',
    trafficMultiplier: 1,
    modifier: only(['redis'], { latencyMultiplier: 0.2, extraErrorRate: 0.95 }),
  },
  {
    id: 'bad-deploy',
    label: 'Bad deploy: search',
    description: 'A regression in search throws on 30% of queries and doubles latency.',
    trafficMultiplier: 1,
    modifier: only(['search'], { latencyMultiplier: 2, extraErrorRate: 0.3 }),
  },
  {
    id: 'traffic-spike',
    label: 'Traffic spike',
    description: 'Marketing sent the email. 4× requests; postgres slows under load.',
    trafficMultiplier: 4,
    modifier: only(['postgres'], { latencyMultiplier: 3, extraErrorRate: 0.01 }),
  },
];

/** Combines active scenarios multiplicatively. */
export function combine(active: readonly Scenario[]): { trafficMultiplier: number; modifier: (service: string) => ServiceModifier } {
  return {
    trafficMultiplier: active.reduce((m, s) => m * s.trafficMultiplier, 1),
    modifier: (service) => {
      let latencyMultiplier = 1;
      let extraErrorRate = 0;
      for (const s of active) {
        const m = s.modifier(service);
        if (m) {
          latencyMultiplier *= m.latencyMultiplier;
          extraErrorRate = 1 - (1 - extraErrorRate) * (1 - m.extraErrorRate);
        }
      }
      return { latencyMultiplier, extraErrorRate };
    },
  };
}
