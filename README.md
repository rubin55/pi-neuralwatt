> **Disclaimer:** This plugin has been developed in co-operation with AI

# Pi Neuralwatt Extension

This extension adds Neuralwatt support to the pi coding agent.

## Installation

Install with one of the following:

```bash
pi install npm:pi-neuralwatt
pi install git:github.com/tedewaard/pi-neuralwatt
pi install https://github.com/tedewaard/pi-neuralwatt
```

## Configuration

### API Key Setup

You can provide your Neuralwatt API key in either of two ways:

**Option 1: Environment Variable (Recommended)**

Set the following variable in your shell or shell configuration before launching pi:

```bash
export NEURALWATT_API_KEY=<your_neuralwatt_api_key>
```

**Option 2: Stored Credentials**

Run `/login` in interactive mode and select the `neuralwatt` provider to store the key in `auth.json` for future sessions.

**Without an API key**

The `/v1/models` catalog is readable without a key, so neuralwatt models are still discovered and registered. Every live API *call*, however, reports that no key is configured: `/neuralwatt:quota` and `/neuralwatt:energy` surface an error, and the status-bar widget (when enabled) displays `⚡no API key configured for neuralwatt`.

## Feature Highlights

* **Dynamic model catalog** – Discovers the `neuralwatt` provider's model catalog at runtime from `https://api.neuralwatt.com/v1/models` (capabilities, context window, per-million pricing), so new upstream models appear without an extension update. On the first run the catalog is empty until pi starts a session and fetches it; thereafter the fetched list is cached to `~/.pi/agent/pi-neuralwatt.json` and re-registered from disk on every startup, so warm starts (and `pi --list-models`) see it instantly without a network round-trip. The cache is refreshed automatically when it expires, and explicitly with `/neuralwatt:refresh`.
* **Cache-Control aware** – The cache expiry is derived from the `/v1/models` response `Cache-Control` header (`s-maxage`, then `max-age`), falling back to a 24h default when the header is absent. `no-cache`/`no-store` mark the catalog immediately stale, so the next startup refetches instead of serving from cache.
* **Reasoning-aware models** – For each model, `reasoning`, `thinkingLevelMap`, and `compat` (`supportsDeveloperRole`, `supportsReasoningEffort`) are derived at fetch time from the API's reported capabilities and pi's curated built-in catalogs (matched by model id), so reasoning models are wired up correctly with no manual configuration. pi uses these fields when crafting requests. If a `/v1/models` fetch fails, the previously cached list (stale or otherwise) is kept.
* **Status-bar widget** – When enabled, shows remaining credit balance plus current-month usage (requests and energy) and spend. Refreshes on session start, after each LLM turn, and on model switch (throttled to once per 60s), and only while a Neuralwatt model is the active model. Disabled by default; enable it with `/neuralwatt:toggle`. The setting is persisted in `~/.pi/agent/pi-neuralwatt.json` (under `statusBarEnabled`) alongside the model cache, so it survives restarts.
* **Slash Commands**
  * `/neuralwatt:energy` – Shows an energy-consumption report for the current period: request count, energy scaled to the most readable unit (µWh/mWh/kWh) plus joules, estimated cost, and a recent 7-day daily breakdown.
  * `/neuralwatt:quota` – Shows your key name, accounting method, account balance (remaining/total and % used), current-month and lifetime usage totals, rate-limit tier, and snapshot timestamp.
  * `/neuralwatt:toggle` – Enable or disable the status-bar widget (disabled by default; persisted across restarts).
  * `/neuralwatt:refresh` – Force-refresh the model catalog from `/v1/models`, bypassing the cache. Reports how many models were refreshed, or falls back to the last cache on failure.

### Usage Example

```bash
# start pi normally – the extension is auto-loaded
pi
```

Once pi starts, you can run `/models` to select a `neuralwatt` model. On a first run (no cached catalog yet), the model list is populated as soon as pi starts its session and fetches `/v1/models`; subsequent runs read from the on-disk cache immediately. Then you can run one of the following commands:

```
/neuralwatt:energy
/neuralwatt:quota
/neuralwatt:toggle
/neuralwatt:refresh
```

The status-bar widget is disabled by default. Run `/neuralwatt:toggle` to enable it — live quota information then appears in the status bar (bottom of the terminal). Run it again to hide it. Run `/neuralwatt:refresh` to force-reload the model catalog from `/v1/models` (e.g. after a new model ships upstream).

## Development

First install the dependencies. This pulls in the `@earendil-works/pi-coding-agent` peer dependency, which provides both the `pi` binary and the extension's types:

```bash
npm install
```

Then run pi with the extension loaded straight from source, so you can iterate on `extensions/neuralwatt.ts` without installing the package:

```bash
pi -e ./extensions/neuralwatt.ts
```

`-e` (`--extension`) takes any local path and can be passed multiple times. If `pi` isn't on your `PATH`, use the copy installed above with `npx pi -e ./extensions/neuralwatt.ts`.

Also note that you should not have an instance of this plugin installed via `npm` or `git`; I've experienced that if you try to load an extension with the same name via `-e` as one already installed, the installed one seems to be preferred.

---
