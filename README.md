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

The preset models are still registered with pi, but every live API call the extension makes will report that no key is configured. Additionally, `/neuralwatt:quota` and `/neuralwatt:energy` surface an error, and the status-bar widget (when enabled) displays `⚡no API key configured for neuralwatt`.

## Feature Highlights

* **Model Registration** – Registers a provider named `neuralwatt` from a static, auto-generated catalog (`extensions/neuralwatt.models.ts`). That catalog is produced offline by `scripts/generate-models.ts`, which snapshots `https://api.neuralwatt.com/v1/models` (capabilities, context window, pricing) and sources each model's `thinkingLevelMap` from pi's built-in catalogs. Regenerate with `bun run generate-models` (or `npm run generate-models`). No call to `/v1/models` is made at runtime.
* **Status-bar widget** – When enabled, shows remaining credit balance plus current-month usage (requests and energy) and spend. Refreshes on session start, after each LLM turn, and on model switch (throttled to once per 60s), and only while a Neuralwatt model is the active model. Disabled by default; enable it with `/neuralwatt:toggle`.
* **Slash Commands**
  * `/neuralwatt:energy` – Shows an energy-consumption report for the current period: request count, energy scaled to the most readable unit (µWh/mWh/kWh) plus joules, estimated cost, and a recent 7-day daily breakdown.
  * `/neuralwatt:quota` – Shows your key name, accounting method, account balance (remaining/total and % used), current-month and lifetime usage totals, rate-limit tier, and snapshot timestamp.
  * `/neuralwatt:toggle` – Enable or disable the status-bar widget (disabled by default).
* **Reasoning-aware models** – Reasoning capability and `thinkingLevelMap` are baked into the generated catalog at generation time (derived from the API's reported capabilities and pi's curated catalogs), so reasoning models are wired up correctly without any runtime configuration. pi uses these fields when crafting requests.

### Usage Example

```bash
# start pi normally – the extension is auto-loaded
pi
```

Once pi starts, you can run `/models` to select a `neuralwatt` model. Then you can run one of the following commands:

```
/neuralwatt:energy
/neuralwatt:quota
/neuralwatt:toggle
```

The status-bar widget is disabled by default. Run `/neuralwatt:toggle` to enable it — live quota information then appears in the status bar (bottom of the terminal). Run it again to hide it.

---
