import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaUsage } from '../src/usage.ts';
import { mergeConfigLayers } from '../src/config.ts';
const now = 100000;
const snapshot = { schema: 'cpa.quota/v1', generatedAt: now, accounts: ['a', 'b'].map(id => ({
 id, prefix: id === 'a' ? 'principal' : 'respaldo', provider: 'antigravity', observedAt: now, stale: false,
 limits: [{ name: 'Claude/GPT', windows: [{ label: 'weekly', usedPercent: 52, windowSeconds: null, resetAt: null }] }],
})) };

test('quota rows display account labels without provider column', () => {
 const usage = quotaUsage(snapshot, 'cliproxyapi', now);
 assert.equal(usage.limits[0].name, 'principal · Claude/GPT');
});

test('hidden account IDs filter rows, not the available account selector', () => {
 const before = JSON.stringify(snapshot);
 const usage = quotaUsage(snapshot, 'cliproxyapi', now, ['a']);
 assert.equal(usage.limits.length, 1);
 assert.equal(usage.limits[0].name, 'respaldo · Claude/GPT');
 assert.equal(usage.accounts.length, 2);
 assert.equal(JSON.stringify(snapshot), before);
 const all = quotaUsage(snapshot, 'cliproxyapi', now, ['a', 'b']);
 assert.deepEqual(all.limits, []);
 assert.match(all.plan!, /hidden/);
});

test('display filter cannot be changed by project settings', () => {
 const config = mergeConfigLayers({ quotaHiddenAccounts: ['a'] }, { quotaHiddenAccounts: [] }, {});
 assert.deepEqual(config.quotaHiddenAccounts, ['a']);
});


test('account selector persists visibility by opaque ID and cancel preserves settings', async () => {
 const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
 const { join } = await import('node:path');
 const { tmpdir } = await import('node:os');
 const { registerCliproxyapiCommand } = await import('../src/commands.ts');
 const previous = process.env.PI_CODING_AGENT_DIR;
 const oldFetch = globalThis.fetch;
 const root = await mkdtemp(join(tmpdir(), 'quota-filter-'));
 const dir = join(root, 'pi-cliproxyapi-provider');
 await mkdir(dir);
 const path = join(dir, 'config.json');
 const key = join(root, 'key');
 await writeFile(key, 'synthetic-key');
 const config = { quotaEnabled: true, apiKeyFile: key, headers: { 'X-Existing': 'preserved' } };
 await writeFile(path, JSON.stringify(config));
 process.env.PI_CODING_AGENT_DIR = root;
 let handler: any;
 let emitted: any;
 registerCliproxyapiCommand({ registerCommand: (_name: string, cmd: any) => { handler = cmd.handler; },
   events: { emit: (_name: string, source: any) => { emitted = source; } },
 } as any);
 globalThis.fetch = (async () => new Response(JSON.stringify({ ...snapshot, generatedAt: Date.now(),
   accounts: snapshot.accounts.map(a => ({ ...a, id: a.id.repeat(24), observedAt: Date.now() })) }))) as typeof fetch;
 const choices: any[] = [0, 'Done'];
 const context: any = { hasUI: true, cwd: root, ui: { notify() {}, select: async (_title: string, options: string[]) => {
   const choice = choices.shift(); return typeof choice === 'number' ? options[choice] : choice;
 } } };
 try {
   await handler('quota accounts', context);
   const saved = JSON.parse(await readFile(path, 'utf8'));
   assert.deepEqual(saved, { ...config, quotaHiddenAccounts: ['a'.repeat(24)] });
   assert.equal(emitted.provider, 'cpa');
   const filtered = await emitted.fetch(undefined, globalThis.fetch, Date.now());
   assert.equal(filtered.limits.length, 1);
   choices.push(0, 'Cancel');
   await handler('quota accounts', context);
   assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), saved);
 } finally {
   globalThis.fetch = oldFetch;
   if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
   else process.env.PI_CODING_AGENT_DIR = previous;
   await rm(root, { recursive: true, force: true });
 }
});
