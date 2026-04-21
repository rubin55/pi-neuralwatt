# Plan: Remove Verbose Model Loading Output on Every Startup

## Problem

Every time PI starts, the `neuralwatt` extension logs a line like:

```
[neuralwatt] Registered 7 models: mistralai/Devstral-Small-2-24B-Instruct-2512, zai-org/GLM-5.1-FP8, Qwen/Qwen3.5-397B-A17B-FP8, ...
```

This is unnecessary noise for a recurring startup — the user already knows the models are there. The model list is available on demand via the model picker (`/model` or `Ctrl+P`), so dumping it to the console every time adds no value.

## Root Cause

In `extensions/neuralwatt.ts`, the `fetchAndRegister` function ends with:

```ts
console.error(`[neuralwatt] Registered ${models.length} models: ${models.map((m) => m.id).join(", ")}`);
```

There is no similar log in `registerFallback`, but the fallback path also registers models silently — the issue is specifically the verbose `console.error` in `fetchAndRegister`.

## Plan

### 1. Replace the verbose model list log with a summary-only message

**File:** `extensions/neuralwatt.ts`  
**Change:** In `fetchAndRegister`, replace:

```ts
console.error(`[neuralwatt] Registered ${models.length} models: ${models.map((m) => m.id).join(", ")}`);
```

with:

```ts
console.error(`[neuralwatt] Registered ${models.length} model${models.length === 1 ? "" : "s"}`);
```

This still confirms that registration succeeded (useful for debugging) but no longer dumps every model ID into the console on each startup. Users can see the full list via the model picker.

### 2. (No other changes needed)

- The fallback registration path (`registerFallback`) already logs nothing — no change required.
- The status bar, `/energy`, and `/quota` features are unrelated and should stay as-is.
- No new configuration flags or environment variables are needed; the behavior should simply be less chatty by default.

## Summary of Changes

| File | What changes | Why |
|---|---|---|
| `extensions/neuralwatt.ts` | Truncate the `console.error` at the end of `fetchAndRegister` to omit the full model ID list | Removes noisy per-startup output while preserving a minimal confirmation log |
