# pi-cliproxyapi-provider

> **Published fork.** This is `pi-cliproxyapi-provider` 0.15.23 (MIT, Richard Hao) as forked at
> [`hank-warren/pi-cliproxyapi-provider@3a4d021`](https://github.com/hank-warren/pi-cliproxyapi-provider/tree/3a4d021),
> six commits ahead of upstream [`0xRichardH/pi-cliproxyapi-provider`](https://github.com/0xRichardH/pi-cliproxyapi-provider):
> Anthropic Messages routing for Claude models, automatic refresh of stale models.dev metadata,
> and `xhigh`/`max` thinking levels derived from models.dev effort lists. The 4.7 MB bundled
> models.dev seed is gone; first-run metadata comes from pi's own built-in model catalog instead.
> Never install both this package and the upstream one at once, or the provider is registered twice.

`pi-cliproxyapi-provider` registers one [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance as a pi model provider. It discovers models from CLIProxyAPI's OpenAI-compatible `/v1/models` endpoint, takes each model's name, limits, input modalities and thinking levels from CLIProxyAPI's own model registry, and fills in cost and anything CLIProxyAPI does not publish from [models.dev](https://models.dev/). Mixed catalogs use OpenAI Completions by default, while Codex-served GPT models (every model in pi's `openai-codex` catalog, plus GPT-5.5, GPT-5.6 and GPT-6 ids the running pi does not list) use the Responses API so pi can read their usage data, and Claude models use the Anthropic Messages API so signed thinking blocks and per-turn thinking effort survive a multi-turn conversation. Canonical `/v1/models` owners such as `openai` select the matching provider metadata; aliases can override that selection when a proxy routes billing differently.

## Install

```bash
pi install npm:@hank-warren/pi-cliproxyapi-provider
```

Restart pi after installing, then run:

```text
/cliproxyapi config
/login cpa
/model
```

To try it without installing, from a checkout of this repository:

```bash
CLIPROXYAPI_BASE_URL=http://localhost:8317/v1 \
CLIPROXYAPI_API_KEY=your-key \
pi -ne -e ./packages/pi-cliproxyapi-provider --list-models cpa
```

## Configure

Run the interactive command:

```text
/cliproxyapi config
```

It writes global connection/auth config to:

```text
<agent-dir>/pi-cliproxyapi-provider/config.json
```

Environment variables override config:

```text
CLIPROXYAPI_BASE_URL
CLIPROXYAPI_PROVIDER_NAME
CLIPROXYAPI_AUTH_REQUIRED
CLIPROXYAPI_AUTH_HEADER
CLIPROXYAPI_MODELS_DEV_ENABLED
CLIPROXYAPI_METADATA_FALLBACK_PROVIDER
```

`CLIPROXYAPI_API_KEY` supplies the discovery credential for non-interactive runs. Set `CLIPROXYAPI_METADATA_FALLBACK_PROVIDER=none` to disable unresolved-model metadata fallback.

Project config supports `metadataFallbackProvider`, metadata aliases, and bounded per-model overrides. Set `metadataFallbackProvider` to `null` or `"none"` to disable fallback. Connection and auth settings such as `baseUrl`, `providerName`, `authRequired`, `authHeader`, and `headers` must be set in global config or environment variables.

### GPT-5.6 / GPT-6 context window

CLIProxyAPI publishes two windows for each Codex-served GPT route: `context_window`, the route's default, and `max_context_window`, the ceiling a `max-context-length` override opens. By default the provider advertises `context_window` (`272000` for most Codex routes, `500000` for GPT-6.1 Sol, `1000000` for Devin's GPT-5.6 routes). Pi's native window, then `272000`, stand in only for a route CLIProxyAPI publishes no window for.

To opt into the full context limit, add this package-specific setting to global `~/.pi/agent/settings.json`:

```json
{
  "pi-cliproxyapi-provider": {
    "gpt56ContextWindow": "full"
  }
}
```

The same setting can be placed in project `.pi/settings.json`; project settings override global settings. Supported values are:

- `"canonical"` (default): advertise CLIProxyAPI's `context_window` for the route.
- `"full"`: advertise the route's ceiling, CLIProxyAPI's `max_context_window` (`872000` for GPT-6 on the Codex route), falling back to the models.dev limit, allowing pi to retain substantially more history before compaction.

Use `"full"` only when the selected CLIProxyAPI route and upstream account actually support that limit. Requests above `272000` input tokens also use the higher models.dev context-pricing tier where one is defined.

### Model and display configuration

Run `/cliproxyapi config` in pi's TUI to edit every package-level `settings.json` value. The tabbed panel has `Connection`, `Models`, and `Display` sections; it controls the GPT-5.6 context-window mode, per-turn Claude effort, Claude mid-conversation updates, and whether the model selector shows the published strict tool-schema capability.

```json
{
  "pi-cliproxyapi-provider": {
    "gpt56ContextWindow": "canonical",
    "perTurnEffort": true,
    "midConversationUpdates": true,
    "showStrictMode": false
  }
}
```

`showStrictMode` defaults to `false` because the selector stays compact for normal use. Enable it when diagnosing tool-schema behaviour; model details always show `Strict tool schema` explicitly. Saving through `/cliproxyapi config` reloads pi. Select `Connection` to open the endpoint and authentication editor.

## Authenticate

Use pi's normal API-key login flow:

```text
/login cpa
```

If you changed the provider name, use that name instead. For non-interactive runs, set:

```bash
export CLIPROXYAPI_API_KEY=your-key
```

## Commands

```text
/cliproxyapi config             # tabbed connection, model, and display configuration
/cliproxyapi config connection  # open endpoint and authentication editor
/cliproxyapi status             # show snapshots, capabilities, and enrichment counts
/cliproxyapi refresh            # refresh models and metadata, then update pi immediately
/cliproxyapi refresh models     # refresh CLIProxyAPI availability only
/cliproxyapi refresh metadata   # refresh models.dev metadata only
/cliproxyapi aliases            # show unmatched model IDs for metadata aliases
/cliproxyapi models             # inspect effective model settings and set bounded overrides
/cliproxyapi help               # show this list
```

## Thinking levels

Pi only offers the extended `xhigh` and `max` thinking levels when a model publishes a `thinkingLevelMap` that names them; without one, every reasoning model stops at `high`.

**CLIProxyAPI's effort list decides first.** Its model catalog (see [How metadata is sourced](#how-metadata-is-sourced)) lists the efforts its registry accepts for each route, and that list decides which levels pi offers: each listed level maps to itself, `none` maps to `off`, and a level CPA does not list is hidden. Two things the list cannot say come from elsewhere:

- **`off` on Claude.** CPA's catalog drops its registry's `zero_allowed` flag, so it can only say `off` by listing `none`, which it never does for Claude. Pi's native Claude definition decides instead: Opus 4.7 and 4.8 keep `off`, which CPA accepts as `thinking.type = disabled`, while Fable 5.x and Opus 5 hide it because the upstream rejects disabled thinking. A Claude model pi does not know takes `off` from the metadata, else pi's default. Every other model without `none` hides `off`.
- **`minimal` on the Codex route**, which has no such effort: pi sends `low` for it, as its native Codex definitions do, instead of hiding the level.

CPA's list is not usable in two cases, and the sources below decide instead. An empty list means the registry describes thinking by budget, or not at all. The exact list `low`/`medium`/`high`/`xhigh` is the `gpt-5.5` template's, which CPA pads onto any model its registry has no thinking data for, so it cannot be told apart from real data and is ignored.

Without a usable CPA list, the package takes the map from the metadata it already has: pi's built-in catalog publishes a finished `thinkingLevelMap` per model, and a models.dev entry that lacks one has its map derived from `reasoning_options` — each effort the provider accepts (`low` … `max`) maps to itself, and any pi level the provider does not accept maps to `null` so pi hides just that level. Claude Fable 5.x, Opus 4.7+ and Sonnet 5 therefore expose `xhigh` and `max`; Opus 4.6 exposes `max` but not `xhigh`; models described only with a thinking budget keep pi's default budget mapping.

`off` follows the same data. A `none` effort maps to it, a `toggle` option leaves it available, and a model with neither (Claude Fable 5.x) marks it `null`, because the upstream rejects `thinking.type = disabled` for those models.

Among those fallbacks, pi's own native definition wins for Claude and Codex-served GPT models. models.dev describes the public APIs, while CLIProxyAPI fronts Anthropic and the Codex backend, which pi's `anthropic` and `openai-codex` catalogs describe exactly — for example, the Codex route has no `minimal` effort (CLIProxyAPI rejects it), so pi's native maps send `low` for it. The package reads those two catalogs from the running pi at load, so a pi upgrade brings new models and capability changes without a release here. Hand-written GPT-5.5, GPT-5.6 and GPT-6 maps remain only as fallbacks for ids the running pi does not list, whether they are newer than it or a later pi dropped them. Pi's native Claude maps also expose `off` for Opus 4.7 and 4.8, which CLIProxyAPI accepts as `thinking.type = disabled`.

A model with neither a usable CPA list nor any of those sources keeps pi's non-reasoning default, which `/cliproxyapi models` can override.

### Per-turn effort (Claude)

**Requires CLIProxyAPI v8.0.3 or later.** Older releases reject the per-turn directive with `messages.N.output_config: Extra inputs are not permitted`, which fails every request to these models; set `"perTurnEffort": false` (or disable it under `/cliproxyapi config` → `Models`) for them, and effort goes back to the request's top-level `output_config`.

Claude models that pi's native catalog marks with `supportsMidConvoEffort` (Opus 5, Opus 5.5, Sonnet 5.5 and Fable 5.1 in pi 1.0) publish it here too, when CLIProxyAPI reports them under the `anthropic` owner. A model it serves from another upstream (Antigravity, an OpenAI-compatible provider) is translated away from the Messages shape, where the directive cannot survive, so it keeps top-level effort. Changing the thinking level mid-session then becomes a per-turn directive instead of a change to the request's top-level `output_config`, so the prompt cache survives the switch: verified through CLIProxyAPI v8.0.3, where an effort switch across a tool loop kept reading the whole cached conversation while the top-level form re-wrote it. Signed thinking replays across the switch. Other Claude models keep top-level effort.

### Mid-conversation updates (Claude)

**Requires CLIProxyAPI v8.0.4 or later.** Earlier releases do not rewrite tool names inside `tool_addition`/`tool_removal` blocks for OAuth credentials ([router-for-me/CLIProxyAPI#6174](https://github.com/router-for-me/CLIProxyAPI/issues/6174)), so the first request after a tool change fails with "references unknown tool"; set `"midConversationUpdates": false` (or disable it under `/cliproxyapi config` → `Models`) for them.

Claude models that pi's native catalog marks with `supportsMidConvoSystemMessages` (and `supportsMidConvoToolChanges`) publish them here too, under the same `anthropic`-owner rule as per-turn effort. Pi then sends a later system-prompt change as a `role: "system"` message and a tool change as `tool_addition`/`tool_removal` blocks against deferred declarations, instead of rewriting the request's system prompt and tool list. The cached prefix survives either change. Verified through CLIProxyAPI v8.0.15 on Opus 5 and Sonnet 5.5 with an OAuth credential:

- Across a turn that removed one tool and added another, the cache read held at about 6300 tokens; the collapsed form read 0 and rewrote the whole prefix.
- The added tool was called by its own name, and CPA mapped its OAuth alias back.
- An effort switch on the same turn kept the cache too.

Models pi does not mark keep the collapsed form, where any system-prompt or tool change rewrites the cache.

## Metadata aliases

Aliases affect metadata only. The package still sends the original CLIProxyAPI model ID to the proxy.

A model id with a routing prefix — an account-pinned alias such as `team/gpt-6-sol`, or a provider namespace such as `devin/claude-opus-5-5` — needs no alias. When the full id matches nothing, the base id after the last `/` is matched instead, so the route gets the model's cost and capabilities while requests keep the prefix that selects the route. An alias for the full id, or for the base id, still wins.

When `/v1/models` reports a canonical owner such as `openai`, the package uses that provider's metadata even if models.dev lists the model under several providers. Noncanonical owners can embed a provider hint, so `feedmob-opencode-go` resolves to `opencode-go` when that provider publishes the model. If ownership is still unresolved, the package uses OpenRouter metadata by default when there is exactly one matching OpenRouter entry. Set `metadataFallbackProvider` to another models.dev provider ID, or to `null`/`"none"` to disable this fallback. Add an alias when CLIProxyAPI's reported owner or fallback does not match the provider whose limits and pricing apply to your setup.

Add global aliases to:

```text
<agent-dir>/pi-cliproxyapi-provider/config.json
```

Add project aliases manually to:

```text
.pi/pi-cliproxyapi-provider/config.json
```

Project config reads `metadataFallbackProvider`, `modelAliases`, and `modelOverrides`; other fields are ignored.

```json
{
  "metadataFallbackProvider": "openrouter",
  "modelAliases": {
    "claude-opus-4-6-thinking": "anthropic/claude-opus-4-6",
    "gpt-5.6-sol": "openai/gpt-5.6-sol"
  },
  "modelOverrides": {
    "gpt-5.6-sol": {
      "contextWindow": 512000,
      "maxTokens": 32768
    }
  }
}
```

## Model inspector and overrides

Run `/cliproxyapi models` in pi's TUI to inspect the models in the current CPA snapshot. The selector shows the effective API, reasoning mode, and context window. The detail view also shows input modalities, cost, thinking levels, and the compatibility values that pi will publish.

Only `reasoning`, `contextWindow`, and `maxTokens` are editable. Values are constrained to safe presets; choose `auto` to remove an override and restore the derived value after reload. API routing and compatibility stay provider-owned: Codex-served GPT models remain on `openai-responses` and Claude models on `anthropic-messages`, while the CLIProxyAPI workaround publishes `supportsStrictMode: false`.

For CPA Responses requests, the extension also applies the Codex-compatible function-tool wire contract used by `pi-codex-conversion`: each function tool explicitly carries `strict: null`. This preserves optional tool arguments such as `interactive_shell.listBackground` without replacing CPA authentication, transport, discovery, or streaming with the ChatGPT-backed `openai-codex-responses` provider.

## Snapshots and startup

```text
CPA /v1/models:      local snapshot at startup, then a background refresh on every model discovery
CPA model specs:     fetched alongside each discovery (/v1/models?client_version=); a failure keeps the previous specs
models.dev metadata: persistent local snapshot, re-fetched in the background once it is a week old
first-run seed:      pi's own built-in model catalog, read in-process, no file and no network
```

Snapshots live under:

```text
<agent-dir>/pi-cliproxyapi-provider/cache/
```

Startup registers the provider immediately from the last-known-good local snapshots and never fetches anything itself. With no metadata snapshot on disk it seeds from pi's built-in catalog, so a cold start already has real costs, context windows and thinking levels for the Anthropic, OpenAI, Codex, xAI, Google and OpenRouter models CLIProxyAPI usually fronts. On a first run with no CPA snapshot, pi registers a placeholder until background discovery succeeds.

Every model discovery pi triggers (startup, opening `/model`) re-checks CLIProxyAPI's model list, and **piggybacks a models.dev fetch when the metadata snapshot is stale**: either it is still the built-in seed, or the cached fetch is more than seven days old. That is what keeps a newly listed model from rendering with pi's bare fallback metadata (16384 output tokens, text only, zero cost) until someone notices. A fresh snapshot is never re-fetched on its own, so the ~7 MB download stays rare. `/cliproxyapi status` flags a stale snapshot; `/cliproxyapi refresh metadata` forces the fetch now.

So the seed is a floor, never a ceiling: the first successful models.dev fetch writes a cache snapshot that **supersedes it entirely**, and from then on the seed is not consulted again unless that cache is deleted or turns out to be a legacy one without source-provider identity. `/cliproxyapi status` names the current source — `builtin (pi catalog generated <age>)` before the first fetch, `cache, <age>` after it.

Manual refreshes update the running provider immediately; `/reload` is not required. Failed refreshes retain the last-known-good data independently for each source — a models.dev outage never blocks CLIProxyAPI model discovery.

## How metadata is sourced

This section summarises the fork's architecture decision record ("Use CLIProxyAPI for discovery and models.dev for metadata"), which is not shipped as a separate file.

CLIProxyAPI is the only source of *availability*: the package discovers models from `GET <baseUrl>/models` and never asks for Management API access, so no powerful management key is needed and the proxy stays the source of truth for what exists. Trusting that endpoint alone is not enough — it returns ids and owners and nothing else — so everything pi needs (context window, output limit, reasoning flag, image support, cost, thinking levels) is enriched from a metadata catalog keyed by `<provider>/<model-id>`. Downloading that catalog at install time was rejected in the same decision: install-time fetches are brittle and go stale in place.

**Limits come from CLIProxyAPI first.** Its OpenAI-shaped `/v1/models` strips each entry to `id`, `object`, `created` and `owned_by`, but the same API key can read the catalog CLIProxyAPI builds for the Codex CLI (`/v1/models?client_version=`), which carries its registry's context window, output limit, effort levels, input modalities and display name — including the entries of a custom `models.catalog` and of provider namespaces such as Devin, whose limits differ from the bare model's. CLIProxyAPI is the proxy that accepts or rejects the request, so **everything it publishes wins**: display name, context window, output limit, input modalities and effort levels. Pi's `max_tokens` then matches what the route allows (`devin/claude-opus-5-5`: 64000, not Anthropic's 128000), and a route CPA serves as text-only is not offered images. That catalog clones a Codex template per model and overlays what the registry knows, so a field the registry lacks keeps template filler. An entry is used only when it carries `max_tokens`, which comes from the registry alone. Its effort levels are used unless they are empty or the template filler (see [Thinking levels](#thinking-levels)). A server that is not CLIProxyAPI ignores the query and returns the plain list, which yields no specs. The catalog is ~2.5 MB uncompressed, so it gets the metadata fetch's time budget rather than discovery's 2 s, and its failure never fails discovery.

Two catalogs fill in what CPA does not publish — cost always, and names, modalities and thinking for models CPA's catalog leaves out or describes only with filler — in this order:

1. **A cached models.dev snapshot** under `<agent-dir>/pi-cliproxyapi-provider/cache/`, when one exists and carries source-provider identity. models.dev's *provider* catalog is used rather than its lab-level one, so provider-specific prices and context-pricing tiers are available. This is the freshness layer: a model listed on models.dev before pi's next release shows up here first.
2. **Pi's built-in model catalog**, read through `@earendil-works/pi-ai`'s `providers/all` subpath, as the first-run seed — replacing the 4.7 MB `data/models-dev-fallback.json` file upstream ships. It is pure static data (no credential, no network, no file of ours), regenerated from models.dev on every pi release, so it can never be older than the pi you are running, and it already carries each model's finished `thinkingLevelMap` — which models.dev does not publish at all. Six providers are seeded: `anthropic`, `openai`, `openai-codex`, `xai`, `google`, `openrouter`. `openai-codex` entries are also registered under `openai/` when that key is free, so CLIProxyAPI's `owned_by: openai` matches the Codex-only ids. Any non-`cache` snapshot counts as stale, so the first model discovery still upgrades it to a live models.dev fetch.

On a pi whose `@earendil-works/pi-ai` does not export `providers/all` — an older release, or a future one that renames it — the read fails soft: the seed is empty, one warning is logged, and every model renders with pi's bare defaults until that first models.dev fetch lands, exactly as it would with no seed at all. Nothing else changes, and upgrading pi closes the gap.

Matching a CLIProxyAPI model id to a catalog entry is identity-first: an explicit alias wins, then an exact id, then a canonical `owned_by` such as `openai`, compared punctuation-insensitively within that owner's provider (Devin's `gpt-5-6-sol` → `openai/gpt-5.6-sol`; CLIProxyAPI's `moonshot` and `zhipu` owners map to `moonshotai` and `zhipuai`), then a provider hint embedded in a noncanonical owner (`feedmob-opencode-go` → `opencode-go`, while `ken-team-litellm` implies no upstream), then a unique normalized suffix. Only if all of that is unresolved does the configured `metadataFallbackProvider` apply, and only when that provider has exactly one normalized match. A prefixed id that still matches nothing is retried as its base id. A models.dev limit of `0` (image-generation models) counts as unknown. Legacy flat caches without source-provider identity are ignored in favour of the seed until a refresh replaces them. Aliases are metadata-only: the registered pi model keeps the original CLIProxyAPI id so requests still route through the proxy correctly.

API routing follows from the same decision. The provider defaults to OpenAI Completions for its mixed catalog; Codex-served GPT models (pi's `openai-codex` catalog, falling back to the GPT-5.5/GPT-5.6/GPT-6 id patterns) take a model-level Responses override because pi's token and cost accounting needs their Responses usage shape; and Claude models take an Anthropic Messages override because CLIProxyAPI proxies Anthropic upstreams at `/v1/messages` with signed thinking blocks intact, while the Chat Completions shape can represent neither those signatures nor per-turn thinking effort — so Claude routed through it loses reasoning continuity across a multi-turn tool loop. Those models also publish `forceAdaptiveThinking`, matching pi's native Claude definitions. Both initial registration and dynamic refreshes publish the same materialised model definitions.

## Attribution

Forked from [`0xRichardH/pi-cliproxyapi-provider`](https://github.com/0xRichardH/pi-cliproxyapi-provider) (MIT, Copyright (c) 2026 Richard Hao). See [LICENSE](LICENSE).

## Pi and Gentle Shell configuration (local fork)

Global configuration follows the active `getAgentDir()` / `PI_CODING_AGENT_DIR`:
`<agent-dir>/pi-cliproxyapi-provider/config.json`. The default Pi directory remains
`~/.pi/agent`; Gentle Shell supplies its own agent directory. Each environment
has an independent cache; non-default agent directories use
`<agent-dir>/pi-cliproxyapi-provider/cache`.
The default Pi agent retains `~/.cache/pi-cliproxyapi-provider` so existing
last-known-good snapshots remain available offline; other agent directories
use their own cache and never read the default Pi cache. Project metadata overrides remain under `.pi/` and cannot
change connection settings or credentials.

An optional **global-only** `apiKeyFile` accepts an absolute path to an existing
private UTF-8 key file. It takes precedence over stored credentials, environment
credentials, and model-refresh credentials for discovery and provider registration.
`apiKeyFile` requires `authRequired: true`; conflicting configuration is rejected.
Missing, unreadable, or empty files fail closed; no alternative credential is used.
The key is read into memory, not saved into configuration or logged; no shell is
invoked. Keep the file private (0600) and its parent directory private (0700).
Without this setting, existing stored-login and `CLIPROXYAPI_API_KEY` behavior
is unchanged. Restart/reload the extension after rotating a key file so request
registration is rebuilt.

```json
{
  "providerName": "cliproxyapi",
  "baseUrl": "http://127.0.0.1:8317/v1",
  "apiKeyFile": "/absolute/private/path/api-key"
}
```

Install only this subpackage directory, not the repository root (which enables
other extensions). Use one owner for the provider catalog: preserve a private
backup before removing a duplicate static provider from `models.json`. Do not
change other providers or defaults. Discovery refreshes when Pi starts or its
model selector requests a refresh; `/cliproxyapi refresh models` refreshes manually.
Image capability is declared metadata, not an inference test. This does not add
native PDF attachments or synchronize OpenCode.


## Optional account quotas

A separate, server-only component in `services/cpa-quota` supplies sanitized
snapshots. Set `"quotaEnabled": true` in the **global** provider config after
that endpoint is deployed; project configuration cannot enable it. Existing
`apiKeyFile` or provider credentials authenticate reads. No administrative
credential belongs in the client. Other providers, catalog discovery and model
routing are unchanged; no Alt+U shortcut is overridden.

Gentle Shell receives a `gentle-pi:usage-source/v1` registration at session start
for the configured provider ID. Its existing Alt+U / `/gentle:usage` panel shows
account-labeled limits. Plain Pi can use `/cliproxyapi quota`. Both only read
`/v0/resource/plugins/account-quota-linux-amd64/snapshot` on the configured CPA
origin (same proxy path prefix); redirects are refused. Remote connections require
HTTPS. Requests have a ten-second deadline and never trigger upstream refresh.

Percentages mean **used**, not remaining. Missing reset times stay unknown;
unknown durations are represented by zero only in Gentle's duration field, never
as an assumed five-hour quota. Snapshots/accounts older than ten minutes are not
presented as current. Unavailable accounts are named in the plan/status message;
valid accounts remain visible. A wholly unavailable snapshot reports an error
rather than zero usage. Only prefix labels and opaque account IDs are shown.
Prefixes are not stable credential identities and do not guarantee which account
the router will choose for an unprefixed model. The sidebar may aggregate/select
rows according to Gentle's own rendering rules; the panel/command is the account
breakdown of record. The feature requires a Gentle version supporting the usage
source event; plain Pi does not provide that panel by itself.

Disable `quotaEnabled` and reload to remove integration on the next session.
This does not install `pi-bridge`, replace Control Account, add inference, or
change subscription allowances. See the server README for deployment/rollback.


### Account visibility in quota views

Quota rows show the configured account prefix/label and the quota group, without
a separate provider column. Accounts without a label use their opaque ID.
Run `/cliproxyapi quota accounts` in an interactive session to toggle accounts:
`[x]` means visible and `[ ]` hidden. **Done** saves; **Cancel** or Esc discards
changes. Reopen Alt+U or press `r` afterwards. The same filter applies to
`/cliproxyapi quota`; hiding every account shows an explicit all-hidden status.
The choice is local to the active agent directory, stored as global
`quotaHiddenAccounts` (opaque IDs), and cannot be changed by project settings.
New accounts are visible by default. Renaming a prefix does not change a filter
while its opaque account identity stays stable. Hidden accounts remain available
for model routing and are still collected by the server; this is a display filter,
not an authorization boundary or a way to disable upstream quota requests.


### Updating an existing fork installation (Linux or Windows client)

This fork's adaptation is on `feat/cpa-account-quotas` in
`https://github.com/Dreykooop/pi-extensions`, not necessarily on `main` or npm.
Use a verified commit from that branch for a reproducible installation. The
package retains its upstream name/version; those alone do not identify this fork.

1. Back up each active agent's provider config and settings privately. Inspect
   the checkout for uncommitted changes before fetching/switching; never force,
   reset, clean, or discard another user's work. Use a separate checkout when
   needed. Fetch only the required fork branch and verify the selected commit.
2. Reuse the existing local subpackage installation when it points at this
   checkout. If using a new checkout, update only its local package reference in
   each agent. Install `packages/pi-cliproxyapi-provider`, **not the repository
   root**. Keep other package declarations, providers and defaults unchanged.
   Prepare the checkout's locked development dependencies with `npm ci
   --ignore-scripts --no-audit --no-fund` if tests/local imports need them; do not
   upgrade the applications or replace their runtimes.
3. Keep the client's existing HTTPS CPA `baseUrl` and private `apiKeyFile`.
   Detect each agent directory; Gentle can choose a different installation home.
   Set only `quotaEnabled: true` to enable the optional quota source. On Windows,
   JSON paths require escaping (for example `"C:\\Users\\USER\\.config\\cliproxyapi-client\\api-key"`).
4. Reuse the remote CPA server. A client laptop does **not** need Docker, Go,
   a local CPA server, the quota plugin, or a collector timer. The Linux server
   component must already be deployed; see `services/cpa-quota/README.md` at the
   repository root for server-only setup. Do not deploy it again for every client.
5. Verify authenticated GET access to both `/v1/models` and
   `/v0/resource/plugins/account-quota-linux-amd64/snapshot` using the existing
   client key, without displaying it. Quota access must be explicitly authorized
   by that server's allowlist; an arbitrary inference key is not automatically
   authorized. Preserve any reverse-proxy path prefix. Remote reachability has
   to be tested separately; local success is not proof of public routing.
   Stop on TLS, redirect, 401, 404, or stale/unavailable errors rather than exposing
   an admin key or widening network access automatically.
6. Run isolated checks with each installed runtime. Gentle's Alt+U requires a
   version with the `gentle-pi:usage-source/v1` contract. Pi without Gentle uses
   `/cliproxyapi quota`. Do not assume older Gentle/Pi versions implement the
   event, and do not update them without authorization. No inference is needed.
7. Reload/restart clients, run `/cliproxyapi quota`, choose visible accounts with
   `/cliproxyapi quota accounts`, and open Alt+U / press `r` in Gentle. Preferences
   are local to each agent; an empty hidden-ID list shows all accounts.

Never transfer the server's management credential, OAuth account files or raw
quota responses to clients or Git. Git carries code and documentation only.
