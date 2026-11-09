import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getDiscoveryApiKey } from './auth.ts';
import type { CpaProviderConfig } from './types.ts';

interface Window { label: string; usedPercent: number; windowSeconds: number; resetAt: number | null }
interface Limit { name: string; windows: Window[]; limitReached: boolean }
interface Usage { provider: string; plan?: string; fetchedAt: number; limits: Limit[] }
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const label = (x: unknown): string => typeof x === 'string'
  ? x.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 100) : '';

export function quotaUsage(raw: unknown, provider: string, now: number): Usage {
  const value = raw as any;
  if (value?.schema !== 'cpa.quota/v1' || !finite(value.generatedAt) || !Array.isArray(value.accounts)) {
    throw new Error('Invalid quota snapshot');
  }
  if (now - value.generatedAt > 600000 || value.generatedAt > now + 60000) throw new Error('Quota snapshot stale');
  const limits: Limit[] = [];
  const unavailable: string[] = [];
  const observed: number[] = [];
  for (const account of value.accounts) {
    if (!account || !Array.isArray(account.limits) || typeof account.id !== 'string') throw new Error('Invalid quota account');
    if (account.stale || account.error || !finite(account.observedAt) || now - account.observedAt > 600000 || account.observedAt > now + 60000) {
      unavailable.push(label(account.prefix) || label(account.provider) + '-' + account.id.slice(0, 8));
      continue;
    }
    observed.push(account.observedAt);
    for (const limit of account.limits) {
      if (!Array.isArray(limit.windows) || !limit.windows.length) throw new Error('Invalid quota limits');
      const windows: Window[] = limit.windows.map((w: any) => {
        if (!w || !finite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 ||
            (w.windowSeconds !== null && (!finite(w.windowSeconds) || w.windowSeconds <= 0)) ||
            (w.resetAt !== null && (!finite(w.resetAt) || w.resetAt < 0 || w.resetAt > 8640000000000000))) throw new Error('Invalid quota window');
        return { label: label(w.label), usedPercent: w.usedPercent,
          // Gentle represents unknown duration with zero; never assume 5h/7d.
          windowSeconds: w.windowSeconds ?? 0, resetAt: w.resetAt };
      });
      limits.push({ name: `${label(account.provider)} · ${label(account.prefix) || account.id.slice(0, 8)} · ${label(limit.name)}`,
        windows, limitReached: windows.some(w => w.usedPercent >= 100) });
    }
  }
  if (!limits.length) throw new Error('No quota windows available');
  return { provider, fetchedAt: Math.min(...observed), limits,
    plan: unavailable.length ? `Unavailable/stale: ${unavailable.join(", ")}` : undefined };
}

export async function fetchQuota(config: CpaProviderConfig, key: string | undefined, fetchFn: typeof fetch,
  now = Date.now(), signal?: AbortSignal): Promise<Usage> {
  if (!key) throw new Error('Quota credential unavailable');
  const base = new URL(config.baseUrl);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    throw new Error('Quota endpoint requires HTTPS or loopback HTTP');
  }
  const path = base.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  base.pathname = path + '/v0/resource/plugins/account-quota-linux-amd64/snapshot';
  const response = await fetchFn(base, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal });
  if (!response.ok) throw new Error('Quota snapshot request failed');
  const text = await response.text();
  if (text.length > 1048576) throw new Error('Quota snapshot too large');
  return quotaUsage(JSON.parse(text), config.providerName, now);
}

export function quotaText(usage: Usage): string {
  return [usage.plan ?? "", `${usage.provider} · observed ${new Date(usage.fetchedAt).toISOString()}`,
    ...usage.limits.flatMap(l => l.windows.map(w => `${l.name} · ${w.label}: ${w.usedPercent}% used · ${w.resetAt === null
      ? 'reset unknown' : 'resets ' + new Date(w.resetAt).toISOString()}`))].join('\n');
}

export function registerQuotaSource(pi: ExtensionAPI, config: CpaProviderConfig): void {
  if (!config.quotaEnabled) return;
  pi.on('session_start', () => {
    pi.events.emit('gentle-pi:usage-source/v1', {
      schema: 'gentle-pi.usage-source/v1', provider: config.providerName,
      pendingNote: 'quota snapshot pending · r to fetch',
      fetch: async (_apiKey: string | undefined, fetchFn: typeof fetch, now: number) => fetchQuota(config,
        await getDiscoveryApiKey(config.providerName, process.env, config.apiKeyFile), fetchFn, now, AbortSignal.timeout(10000)),
    });
  });
}
