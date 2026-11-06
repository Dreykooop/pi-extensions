import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { writeCache } from "../src/cache.ts";
import { modelsDevCachePath } from "../src/discovery.ts";

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cpa-extension-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await fn(cwd);
  } finally {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

test("extension registers provider with refreshModels capability", async () => {
  const scratchHome = process.env.HOME!;
  const scratchAgent = process.env.PI_CODING_AGENT_DIR;
  const home = await mkdtemp(join(scratchHome, "pi-cpa-extension-lifecycle-home-"));
  const originalFetch = globalThis.fetch;

  try {
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), "http://localhost:8317/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "fresh-model" }] }), { status: 200 });
    }) as typeof fetch;

    await withTempCwd(async () => {
      const providers: Array<{ name: string; config: any }> = [];
      await extension({
        registerCommand: () => {},
        registerProvider: (name: string, config: any) => providers.push({ name, config }),
        on: () => {},
      } as any);

      assert.equal(providers[0].config.models[0].id, "login-required");
      assert.equal(typeof providers[0].config.refreshModels, "function");

      const refreshed = await providers[0].config.refreshModels({
        allowNetwork: true,
        signal: new AbortController().signal,
        publish: async () => true,
      });
      assert.equal(refreshed[0].id, "fresh-model");
      assert.equal(refreshed[0].compat?.supportsStrictMode, false);
      assert.equal(providers.length, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.HOME = scratchHome;
    if (scratchAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = scratchAgent;
    await rm(home, { recursive: true, force: true });
  }
});

test("extension applies the full GPT-5.6 context window from settings.json", async () => {
  const scratchHome = process.env.HOME!;
  const scratchAgent = process.env.PI_CODING_AGENT_DIR;
  const home = await mkdtemp(join(scratchHome, "pi-cpa-extension-settings-home-"));
  const originalFetch = globalThis.fetch;
  // Global settings resolve through pi's agent dir, which the hermetic preload
  // points at this process's scratch directory rather than `$HOME/.pi/agent`.
  const agentDir = join(home, ".pi", "agent");
  const settingsPath = join(agentDir, "settings.json");

  try {
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      "pi-cliproxyapi-provider": { gpt56ContextWindow: "full" },
    }));
    // A fresh metadata cache both supplies the models.dev context limit the
    // setting opts into and keeps the refresh below from fetching models.dev.
    await writeCache(modelsDevCachePath(), {
      "openai/gpt-5.6-sol": {
        id: "openai/gpt-5.6-sol",
        sourceProvider: "openai",
        name: "GPT-5.6 Sol",
        reasoning: true,
        limit: { context: 1050000, output: 128000 },
      },
    });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ id: "gpt-5.6-sol", owned_by: "openai" }],
    }), { status: 200 })) as typeof fetch;

    await withTempCwd(async () => {
      const providers: Array<{ name: string; config: any }> = [];
      await extension({
        registerCommand: () => {},
        registerProvider: (name: string, config: any) => providers.push({ name, config }),
        on: () => {},
      } as any);

      const refreshed = await providers[0].config.refreshModels({
        allowNetwork: true,
        signal: new AbortController().signal,
        publish: async () => true,
      });
      const model = refreshed.find((entry: any) => entry.id === "gpt-5.6-sol");
      assert.equal(model?.contextWindow, 1050000);
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.HOME = scratchHome;
    if (scratchAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = scratchAgent;
    await rm(settingsPath, { force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("manual refresh uses the active model registry credential", async () => {
  const scratchHome = process.env.HOME!;
  const scratchAgent = process.env.PI_CODING_AGENT_DIR;
  const home = await mkdtemp(join(scratchHome, "pi-cpa-extension-refresh-home-"));
  const originalFetch = globalThis.fetch;

  try {
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    await withTempCwd(async (cwd) => {
      let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      let receivedAuthorization: string | null = null;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        receivedAuthorization = headers.get("Authorization");
        if (receivedAuthorization !== "Bearer runtime-key") {
          return new Response("unauthorized", { status: 401, statusText: "Unauthorized" });
        }
        return new Response(JSON.stringify({ data: [{ id: "fresh-model" }] }), { status: 200 });
      }) as typeof fetch;

      await extension({
        registerCommand: (_name: string, options: any) => { commandHandler = options.handler; },
        registerProvider: () => {},
        on: () => {},
      } as any);

      const notifications: Array<{ message: string; level: string }> = [];
      await commandHandler?.("refresh models", {
        cwd,
        modelRegistry: {
          getApiKeyForProvider: async (providerName: string) => {
            assert.equal(providerName, "cpa");
            return "runtime-key";
          },
        },
        ui: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
        },
      });

      assert.equal(receivedAuthorization, "Bearer runtime-key");
      assert.equal(notifications.at(-1)?.level, "info");
      assert.doesNotMatch(notifications.at(-1)?.message ?? "", /401 Unauthorized/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.HOME = scratchHome;
    if (scratchAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = scratchAgent;
    await rm(home, { recursive: true, force: true });
  }
});

test("extension registers placeholder provider when global config is invalid", async () => {
  const scratchHome = process.env.HOME!;
  const scratchAgent = process.env.PI_CODING_AGENT_DIR;
  const home = await mkdtemp(join(scratchHome, "pi-cpa-extension-home-"));

  try {
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    await withTempCwd(async () => {
      const configDir = join(home, ".pi", "agent", "pi-cliproxyapi-provider");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.json"), JSON.stringify({ headers: null }));

      const providers: Array<{ name: string; config: any }> = [];
      await extension({
        registerCommand: () => {},
        registerProvider: (name: string, config: any) => providers.push({ name, config }),
        on: () => {},
      } as any);

      assert.equal(providers.length, 1);
      assert.equal(providers[0].name, "cpa");
      assert.equal(providers[0].config.models[0].id, "login-required");
      assert.equal(providers[0].config.models[0].compat.supportsStrictMode, false);
    });
  } finally {
    process.env.HOME = scratchHome;
    if (scratchAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = scratchAgent;
    await rm(home, { recursive: true, force: true });
  }
});


test("invalid explicit key-file configuration never registers fallback credentials", async () => {
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousKey = process.env.CLIPROXYAPI_API_KEY;
  const agent = await mkdtemp(join(tmpdir(), "cpa-fail-closed-"));
  const configDir = join(agent, "pi-cliproxyapi-provider");
  await mkdir(configDir);
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.CLIPROXYAPI_API_KEY = "synthetic-fallback";
  try {
    for (const config of [
      { apiKeyFile: "relative" },
      { apiKeyFile: join(agent, "missing"), metadataFallbackProvider: 12 },
      { apiKeyFile: join(agent, "missing"), authRequired: false },
    ]) {
      await writeFile(join(configDir, "config.json"), JSON.stringify(config));
      const registrations: unknown[] = [];
      await assert.rejects(extension({
        registerProvider: (...args: unknown[]) => registrations.push(args),
        registerCommand() {}, on() {},
      } as any), /apiKeyFile|key-file|metadataFallbackProvider/);
      assert.deepEqual(registrations, []);
    }
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousKey === undefined) delete process.env.CLIPROXYAPI_API_KEY;
    else process.env.CLIPROXYAPI_API_KEY = previousKey;
    await rm(agent, { recursive: true, force: true });
  }
});


test("malformed global JSON preserves placeholder startup recovery", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agent = await mkdtemp(join(tmpdir(), "cpa-malformed-"));
  const configDir = join(agent, "pi-cliproxyapi-provider");
  await mkdir(configDir);
  await writeFile(join(configDir, "config.json"), "{invalid");
  process.env.PI_CODING_AGENT_DIR = agent;
  const registrations: any[] = [];
  const warn = console.warn;
  try {
    console.warn = () => {};
    await extension({ registerCommand() {}, on() {},
      registerProvider: (name: string, config: any) => registrations.push({ name, config }),
    } as any);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].config.models[0].id, "login-required");
  } finally {
    console.warn = warn;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agent, { recursive: true, force: true });
  }
});
