> **Disclaimer:** This plugin has been generated using AI

# Pi Neuralwatt Extension

This extension adds Neuralwatt support to the PI coding agent.

## Installation
Install with one of the following:
```bash
pi install npm:pi-neuralwatt
pi install git:github.com/tedewaard/pi-neuralwatt
pi install https://github.com/tedewaard/pi-neuralwatt
```

## Environment Variable

Set the following variable in your shell or shell configuration before launching PI:

```sh
export NEURALWATT_API_KEY=<your_neuralwatt_api_key>
```

If the key is missing, the extension will log a warning and fall back to a preset list of models.

## Feature Highlights

* **Model Registration** – On startup, the extension queries `https://api.neuralwatt.com/v1/models` and registers all returned models as a provider named `neuralwatt`. If the call fails, a small set of hand‑picked fallback models (e.g. Devstral, GLM‑5.1, Qwen‑3.5) is registered.
* **Status‑bar widget** – Displays current quota usage, remaining balance, monthly usage and cost. Updated on session start and after each LLM turn.
* **Slash Commands**
  * `/energy` – Shows a detailed energy‑consumption report for the current period, including requests, energy in kWh/µWh, and estimated cost.
  * `/quota` – Shows your account balance, running totals for the current month and lifetime, rate‑limit tier, and snapshot timestamp.
* **Reasoning‑aware models** – The extension marks certain models as *reasoning* capable. In configuration you can specify which models; these fields are used internally when crafting requests.
* **Token & cost overrides** – For small‑context models you can override the `maxTokens` value for better interaction (see `MAX_TOKENS_OVERRIDE`).

### Usage Example

```sh
# start PI normally – the extension is auto‑loaded
pi
```

Once PI starts, you can run:

```
/energy
/quota
```

Live status information will appear in the status bar (bottom of the terminal).

---

