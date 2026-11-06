import { readFileSync } from "node:fs";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

export function readApiKeyFile(path: string): string {
  try {
    const key = readFileSync(path, "utf8").trim();
    if (key) return key;
  } catch {
    // Do not expose filesystem errors or credential contents.
  }
  throw new Error("Cannot read a non-empty CLIProxyAPI key file");
}

export async function getDiscoveryApiKey(providerName: string, env: NodeJS.ProcessEnv = process.env, apiKeyFile?: string): Promise<string | undefined> {
  if (apiKeyFile !== undefined) return readApiKeyFile(apiKeyFile);
  try {
    const credential = await readStoredCredential(providerName);
    if (credential?.type === "api_key") return credential.key;
    return env.CLIPROXYAPI_API_KEY;
  } catch {
    return env.CLIPROXYAPI_API_KEY;
  }
}
