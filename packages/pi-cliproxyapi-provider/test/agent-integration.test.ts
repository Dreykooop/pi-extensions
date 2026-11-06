import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheDir, globalConfigPath, mergeConfigLayers, readConfigFile } from "../src/config.ts";
import { getDiscoveryApiKey } from "../src/auth.ts";
import { buildProviderRegistration } from "../src/registration.ts";

const scratch = mkdtempSync(join(tmpdir(), "cpa-integration-"));

test("configuration and cache follow the active agent directory", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    for (const name of ["pi", "gentle"]) {
      const agent = join(scratch, name);
      process.env.PI_CODING_AGENT_DIR = agent;
      assert.equal(globalConfigPath(), join(agent, "pi-cliproxyapi-provider", "config.json"));
      assert.equal(cacheDir(), join(agent, "pi-cliproxyapi-provider", "cache"));
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("global key file supplies discovery and registered request credentials", async () => {
  const file = join(scratch, "key with spaces");
  writeFileSync(file, "synthetic-key\n", { mode: 0o600 });
  const config = mergeConfigLayers({ apiKeyFile: file }, { apiKeyFile: "/untrusted" }, {});
  assert.equal(config.apiKeyFile, file);
  assert.equal(await getDiscoveryApiKey(config.providerName, { CLIPROXYAPI_API_KEY: "other" }, config.apiKeyFile), "synthetic-key");
  assert.equal(buildProviderRegistration(config, []).config.apiKey, "synthetic-key");
  assert.equal(mergeConfigLayers(undefined, { apiKeyFile: file }, {}).apiKeyFile, undefined);
});

test("an explicit missing or empty key file fails closed without exposing contents", async () => {
  for (const file of [join(scratch, "missing"), join(scratch, "empty")]) {
    if (file.endsWith("empty")) writeFileSync(file, " \n");
    const config = mergeConfigLayers({ apiKeyFile: file }, undefined, {});
    await assert.rejects(getDiscoveryApiKey(config.providerName, { CLIPROXYAPI_API_KEY: "fallback-secret" }, file), /^Error: Cannot read a non-empty CLIProxyAPI key file$/);
    assert.throws(() => buildProviderRegistration(config, []), /^Error: Cannot read a non-empty CLIProxyAPI key file$/);
  }
});

test("key file configuration rejects relative and non-string paths", () => {
  const path = join(scratch, "invalid.json");
  for (const apiKeyFile of ["relative/key", "", 12]) {
    writeFileSync(path, JSON.stringify({ apiKeyFile }));
    assert.throws(() => readConfigFile(path), /apiKeyFile must be an absolute path/);
  }
});

test("without key file, environment registration and discovery remain available", async () => {
  const config = mergeConfigLayers({ providerName: "isolated-cpa-test" }, undefined, {});
  assert.equal(buildProviderRegistration(config, []).config.apiKey, "$CLIPROXYAPI_API_KEY");
  assert.equal(await getDiscoveryApiKey(config.providerName, { CLIPROXYAPI_API_KEY: "environment-key" }), "environment-key");
});
