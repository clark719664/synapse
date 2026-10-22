import type { SpanKind } from '../model/span';

/** A node in a call-tree template. Latencies are milliseconds. */
export interface CallTemplate {
  service: string;
  name: string;
  kind?: SpanKind;
  /** Median self time (excluding children). */
  base: number;
  /** Log-normal spread; 0.3 is "normal service", 0.8 is "spiky". */
  jitter?: number;
  /** Baseline probability this call fails on its own. */
  errorRate?: number;
  /** Children run one after another unless `parallel`. */
  parallel?: boolean;
  children?: ChildTemplate[];
}

export interface ChildTemplate {
  /** Probability the child is called at all. */
  prob?: number;
  call: CallTemplate;
}

export interface Route {
  name: string;
  weight: number;
  root: CallTemplate;
}

const c = (call: CallTemplate, prob?: number): ChildTemplate => (prob === undefined ? { call } : { prob, call });

const postgres = (name: string, base = 4): CallTemplate => ({ service: 'postgres', name, kind: 'client', base, jitter: 0.6 });
const redis = (name: string, base = 0.6): CallTemplate => ({ service: 'redis', name, kind: 'client', base, jitter: 0.4 });

const auth: CallTemplate = {
  service: 'auth', name: 'POST /verify', kind: 'server', base: 3, jitter: 0.3,
  children: [c(redis('GET session')), c(postgres('SELECT users'), 0.15)],
};

const catalog: CallTemplate = {
  service: 'catalog', name: 'GET /products', kind: 'server', base: 6, jitter: 0.4,
  children: [c(redis('MGET products')), c(postgres('SELECT products', 9), 0.35)],
};

const search: CallTemplate = {
  service: 'search', name: 'GET /search', kind: 'server', base: 8, jitter: 0.5,
  children: [c({ service: 'elasticsearch', name: 'POST _search', kind: 'client', base: 22, jitter: 0.7 })],
};

const recommendations: CallTemplate = {
  service: 'recommendations', name: 'GET /recs', kind: 'server', base: 14, jitter: 0.6,
  parallel: true,
  children: [c(redis('HGETALL features', 1.2)), c({ service: 'feature-store', name: 'Lookup', kind: 'client', base: 10, jitter: 0.5 })],
};

const cart: CallTemplate = {
  service: 'cart', name: 'GET /cart', kind: 'server', base: 3, jitter: 0.3,
  children: [c(redis('HGETALL cart'))],
};

const payments: CallTemplate = {
  service: 'payments', name: 'POST /charge', kind: 'server', base: 12, jitter: 0.4, errorRate: 0.015,
  children: [c({ service: 'stripe', name: 'POST /v1/charges', kind: 'client', base: 180, jitter: 0.5, errorRate: 0.01 }), c(postgres('INSERT payments', 5))],
};

const inventory: CallTemplate = {
  service: 'inventory', name: 'POST /reserve', kind: 'server', base: 5, jitter: 0.4, errorRate: 0.004,
  children: [c(postgres('UPDATE stock', 7))],
};

const shipping: CallTemplate = {
  service: 'shipping', name: 'POST /quote', kind: 'server', base: 9, jitter: 0.5,
  children: [c(postgres('SELECT rates', 3))],
};

const notifications: CallTemplate = {
  service: 'notifications', name: 'order.created', kind: 'consumer', base: 4, jitter: 0.4,
  children: [c({ service: 'email-provider', name: 'POST /send', kind: 'client', base: 120, jitter: 0.6, errorRate: 0.01 })],
};

const checkout: CallTemplate = {
  service: 'checkout', name: 'POST /checkout', kind: 'server', base: 10, jitter: 0.4,
  children: [
    c(cart),
    c(inventory),
    c(shipping, 0.8),
    c(payments),
    c({ service: 'kafka', name: 'publish order.created', kind: 'producer', base: 2, jitter: 0.5, children: [c(notifications)] }),
  ],
};

const bff = (name: string, children: ChildTemplate[], parallel = true): CallTemplate => ({
  service: 'web-bff', name, kind: 'server', base: 4, jitter: 0.3, parallel, children,
});

const gateway = (name: string, child: CallTemplate): CallTemplate => ({
  service: 'edge-gateway', name, kind: 'server', base: 1.5, jitter: 0.2, children: [c(auth, 0.9), c(child)],
});

/** A plausible e-commerce backend. Weights are relative request frequencies. */
export const DEMO_ROUTES: Route[] = [
  { name: 'GET /home', weight: 40, root: gateway('GET /home', bff('GET /home', [c(catalog), c(recommendations), c(cart, 0.6)])) },
  { name: 'GET /search', weight: 25, root: gateway('GET /search', bff('GET /search', [c(search), c(catalog, 0.5)])) },
  { name: 'GET /product', weight: 20, root: gateway('GET /product/:id', bff('GET /product/:id', [c(catalog), c(recommendations, 0.7)])) },
  { name: 'POST /cart', weight: 8, root: gateway('POST /cart', bff('POST /cart', [c({ ...cart, name: 'POST /cart', children: [c(redis('HSET cart'))] })], false)) },
  { name: 'POST /checkout', weight: 5, root: gateway('POST /checkout', bff('POST /checkout', [c(checkout)], false)) },
  { name: 'GET /account', weight: 2, root: gateway('GET /account', bff('GET /account', [c({ ...auth, name: 'GET /profile', children: [c(postgres('SELECT users'))] })], false)) },
];

/** Data stores and third parties are leaves; the layout and palette treat them differently. */
export const INFRA_SERVICES = new Set(['postgres', 'redis', 'elasticsearch', 'kafka', 'feature-store']);
export const EXTERNAL_SERVICES = new Set(['stripe', 'email-provider']);
