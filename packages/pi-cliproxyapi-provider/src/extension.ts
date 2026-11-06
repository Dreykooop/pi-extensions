import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, readConfigFile, globalConfigPath } from "./config.ts";
import { ProviderCatalog } from "./catalog.ts";
import { ProviderRuntime } from "./runtime.ts";
import { buildProviderRegistration } from "./registration.ts";
import { buildUnavailableProviderModels } from "./provider.ts";
import { registerCliproxyapiCommand } from "./commands.ts";
import { getDiscoveryApiKey } from "./auth.ts";
import { loadProviderSettings } from "./settings.ts";
import { registerCodexCompatiblePayloadAdapter } from "./codex-compat.ts";

export default async function (pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  // Validate trusted global configuration outside the placeholder fallback.
  // Invalid credential references must never activate a different credential.
  const globalPath = globalConfigPath();
  let explicitKeyFile = false;
  try {
    const rawGlobal = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, "utf8")) : undefined;
    explicitKeyFile = !!rawGlobal && Object.prototype.hasOwnProperty.call(rawGlobal, "apiKeyFile");
    readConfigFile(globalPath);
  } catch (error) {
    if (explicitKeyFile || (error instanceof Error && error.message.includes("apiKeyFile"))) throw error;
  }
  try {
    const cwd = process.cwd();
    config = loadConfig(cwd);
    const settings = loadProviderSettings(cwd);
    const catalog = new ProviderCatalog({
      config,
      gpt56ContextWindow: settings.gpt56ContextWindow,
      perTurnEffort: settings.perTurnEffort,
      midConversationUpdates: settings.midConversationUpdates,
      getApiKey: () => getDiscoveryApiKey(config.providerName, process.env, config.apiKeyFile),
    });
    const runtime = new ProviderRuntime({ pi, config, catalog });
    registerCodexCompatiblePayloadAdapter(pi, config.providerName);
    registerCliproxyapiCommand(pi, runtime, catalog);
    await runtime.start();
  } catch (error) {
    if (config.apiKeyFile !== undefined || (error instanceof Error && error.message.includes("apiKeyFile"))) {
      throw new Error("CLIProxyAPI key-file provider could not be initialized");
    }
    registerCodexCompatiblePayloadAdapter(pi, config.providerName);
    registerCliproxyapiCommand(pi);
    pi.registerProvider(config.providerName, buildProviderRegistration(config, buildUnavailableProviderModels()).config);
    console.warn(`[pi-cliproxyapi-provider] registered placeholder provider after startup failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}
