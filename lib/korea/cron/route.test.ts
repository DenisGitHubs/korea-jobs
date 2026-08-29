// lib/korea/cron/route.test.ts
//
// The combined pass only helps if the SCHEDULER can actually reach it. A handler that exists but
// is not in the route table answers 404 — and the external scheduler would go on calling the old
// endpoints (or nothing at all) while every test about the tick itself stays green.
//
// So this asks the router, not the handler: /api/cron/tick must resolve to something that checks
// the secret (401), not to "no such route" (404). The door is proven by the difference between
// those two numbers.
//
// NOTE the file location: a test placed in api/ would be picked up by Vercel as a separate
// serverless entry point (and it imports vitest, which is not a production dependency). Route
// tests therefore live under lib/ and import the router from there.

import { describe, it, expect } from 'vitest';
import router from '../../../api/index.js';
import type { ReqLike, ResLike } from '../core/http.js';

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    setHeader(_n: string, _v: string) {},
    end(b: string) {
      this.body = b;
    },
  };
}

const call = async (path: string, method = 'POST', auth?: string) => {
  const res = makeRes();
  await router(
    { method, headers: auth ? { authorization: auth } : {}, query: { path } } as ReqLike,
    res as unknown as ResLike,
  );
  return res;
};

describe('/api/cron/tick is wired into the router', () => {
  it('answers 401 without the secret — which proves the route exists at all', async () => {
    process.env.CRON_SECRET = 'route-test-secret';
    expect((await call('cron/tick')).statusCode).toBe(401);
  });

  it('is POST-only', async () => {
    process.env.CRON_SECRET = 'route-test-secret';
    expect((await call('cron/tick', 'GET', 'Bearer route-test-secret')).statusCode).toBe(404);
  });

  it('the individual cron endpoints are still reachable (kept for a manual run)', async () => {
    process.env.CRON_SECRET = 'route-test-secret';
    for (const path of [
      'cron/parse',
      'cron/notify',
      'cron/digest',
      'cron/cleanup',
      'cron/scheduled',
      'cron/inactive-erase',
      'cron/referral-confirm',
    ]) {
      expect((await call(path)).statusCode, path).toBe(401); // 401, not 404 = still routed
    }
  });

  it('an invented cron path is 404', async () => {
    expect((await call('cron/nope')).statusCode).toBe(404);
  });
});
