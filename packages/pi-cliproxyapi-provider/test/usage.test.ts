import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaUsage, fetchQuota, quotaText, registerQuotaSource } from '../src/usage.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const snapshot = { schema: 'cpa.quota/v1', generatedAt: 1000, accounts: [
  { id: 'opaque', provider: 'antigravity', prefix: 'mian-agy', observedAt: 1000,
    stale: false, error: null, limits: [{ name: 'Claude/GPT', windows: [
      { label: 'weekly', usedPercent: 52, windowSeconds: null, resetAt: null } ] }] },
] };

test('maps account labels and used percent without inventing reset or duration', () => {
  const result = quotaUsage(snapshot, 'cliproxyapi', 2000);
  assert.equal(result.provider, 'cliproxyapi');
  assert.match(result.limits[0].name, /mian-agy.*Claude\/GPT/);
  assert.equal(result.limits[0].windows[0].usedPercent, 52);
  assert.equal(result.limits[0].windows[0].resetAt, null);
  assert.match(quotaText(result), /52% used/);
});

test('rejects invalid or out of range windows and stale snapshots', () => {
  for (const value of [NaN, -1, 101]) {
    const bad = structuredClone(snapshot);
    bad.accounts[0].limits[0].windows[0].usedPercent = value;
    assert.throws(() => quotaUsage(bad, 'cliproxyapi', 2000));
  }
  assert.throws(() => quotaUsage(snapshot, 'cliproxyapi', 1000000), /stale/);
});

test('fetch uses same origin resource endpoint, refuses redirects and passes signal', async () => {
  const controller = new AbortController();
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://example.test/v0/resource/plugins/account-quota-linux-amd64/snapshot');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.signal, controller.signal);
    assert.equal((init?.headers as any).Authorization, 'Bearer synthetic-key');
    return new Response(JSON.stringify(snapshot));
  };
  const result = await fetchQuota({ ...DEFAULT_CONFIG, baseUrl: 'https://example.test/v1' }, 'synthetic-key', fake as typeof fetch, 2000, controller.signal);
  assert.equal(result.limits.length, 1);
});


test('rejects future account observations', () => {
  const bad = structuredClone(snapshot);
  bad.accounts[0].observedAt = 86402000;
  assert.throws(() => quotaUsage(bad, 'cliproxyapi', 2000));
});

test('registered Gentle source supplies a bounded abort signal', async () => {
  let start: (() => void) | undefined;
  let source: any;
  registerQuotaSource({ on: (_name: string, callback: () => void) => { start = callback; },
    events: { emit: (_name: string, payload: unknown) => { source = payload; } },
  } as any, { ...DEFAULT_CONFIG, providerName: 'isolated-quota-test', quotaEnabled: true });
  start!();
  const previous = process.env.CLIPROXYAPI_API_KEY;
  process.env.CLIPROXYAPI_API_KEY = 'synthetic';
  try {
    await source.fetch(undefined, async (_url: unknown, init: RequestInit) => {
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(JSON.stringify(snapshot));
    }, 2000);
  } finally {
    if (previous === undefined) delete process.env.CLIPROXYAPI_API_KEY;
    else process.env.CLIPROXYAPI_API_KEY = previous;
  }
});
