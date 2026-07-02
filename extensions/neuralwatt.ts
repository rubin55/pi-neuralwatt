import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// ─── Configuration ──────────────────────────────────────────────────

const BASE_URL = "https://api.neuralwatt.com/v1";
const STATUS_KEY = "neuralwatt";

// Settings file, stores models, settings.
const STATE_PATH = join(getAgentDir(), "pi-neuralwatt.json");

// USD per kWh (source: https://portal.neuralwatt.com/energy-pricing).
const ENERGY_RATE_PER_KWH = 5.0;

// Cap status-bar refreshes at one per 60s to spare the API.
const STATUS_UPDATE_MIN_INTERVAL = 60_000;

// How many recent days the /neuralwatt:energy daily breakdown shows.
const RECENT_DAYS = 7;

// Default cache lifetime when the API sends no Cache-Control hint.
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h.

// Fallbacks when /v1/models omits these fields.
const DEFAULT_CONTEXT_WINDOW = 131072; // 128k.
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

// Per-model effort map: level (off|minimal|low|medium|high|xhigh)
// to provider value, or null to disable.
type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

// Initialize lastStatusUpdate.
let lastStatusUpdate = 0;

// Initialize an empty state.
const EMPTY_STATE: State = { statusBarEnabled: false, modelsFetchedAt: null, modelsExpireAt: null, models: null };

// In-memory mirror of STATE_PATH; readState() replaces it at startup.
let state: State = { ...EMPTY_STATE };

// Dedupes concurrent refresh attempts (e.g. /neuralwatt:refresh.
let refreshInFlight: Promise<ProviderModelConfig[]> | null = null;

// ─── Entry Point ────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // Register the cached catalog immediately; session_start refetches if stale.
  state = await readState();
  registerModels(pi, state.models ?? []);

  // On process start/reload, refresh the catalog if stale, then the status bar.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" || event.reason === "reload") {
      try {
        await ensureModels(pi, ctx, { force: false });
      } catch (err: any) {
        ctx.ui.notify(`Neuralwatt: couldn't load models — ${err.message}. Re-run /neuralwatt:refresh when online.`, "warning");
      }
    }
    await refreshStatus(ctx);
  });

  // Refresh after each LLM turn.
  pi.on("turn_end", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  // Model switch.
  pi.on("model_select", async (_event, ctx) => {
    lastStatusUpdate = 0;
    await refreshStatus(ctx);
  });

  // Command /neuralwatt:refresh.
  pi.registerCommand("neuralwatt:refresh", {
    description: "Refresh the Neuralwatt model catalog from /v1/models",
    handler: async (_args, ctx) => {
      const before = state.modelsFetchedAt;
      try {
        const models = await ensureModels(pi, ctx, { force: true });
        // If the fetch failed, ensureModels silently fell back to the stale
        // cache; detect that by checking whether modelsFetchedAt advanced.
        if (before !== null && state.modelsFetchedAt === before) {
          ctx.ui.notify(
            `Neuralwatt: refresh failed — using ${models.length} cached models (from ${new Date(before).toLocaleString()})`,
            "warning",
          );
        } else {
          ctx.ui.notify(`Neuralwatt: refreshed ${models.length} models`, "info");
        }
      } catch (err: any) {
        ctx.ui.notify(`Neuralwatt: model refresh failed — ${err.message}`, "error");
      }
    },
  });

  // Command /neuralwatt:energy.
  pi.registerCommand("neuralwatt:energy", {
    description: "Show Neuralwatt energy consumption stats",
    handler: async (_args, ctx) => {
      try {
        const data: EnergyResponse = await apiGet(ctx, "/usage/energy");
        const totals = data.totals;
        const lines = [
          `⚡ Neuralwatt Energy Usage`,
          `   Period: ${data.period.start} → ${data.period.end}`,
          ``,
          `   Requests:      ${totals.requests}`,
          `   Energy:        ${formatEnergy(totals.energy_kwh)}`,
          `   Energy (J):    ${totals.energy_joules.toFixed(2)} J`,
          `   Est. cost:     $${(totals.energy_kwh * ENERGY_RATE_PER_KWH).toFixed(4)}`,
        ];
        if (data.daily?.length) {
          lines.push(``, `   Daily breakdown (last ${Math.min(data.daily.length, RECENT_DAYS)} days):`);
          for (const day of data.daily.slice(0, RECENT_DAYS)) {
            const cost = (day.energy_kwh * ENERGY_RATE_PER_KWH).toFixed(4);
            lines.push(`     ${day.date}  ${String(day.requests).padStart(4)} reqs  ${formatEnergy(day.energy_kwh).padStart(12)}  $${cost}`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to fetch energy data: ${err.message}`, "error");
      }
    },
  });

  // Command /neuralwatt:quota.
  pi.registerCommand("neuralwatt:quota", {
    description: "Show Neuralwatt account balance and quota",
    handler: async (_args, ctx) => {
      try {
        const data: QuotaResponse = await apiGet(ctx, "/quota");
        const b = data.balance;
        const pctUsed = ((b.credits_used_usd / b.total_credits_usd) * 100).toFixed(1);
        const cm = data.usage.current_month;
        const lt = data.usage.lifetime;

        const lines = [
          `💰 Neuralwatt Account`,
          `   Key:            ${data.key.name}`,
          `   Method:         ${b.accounting_method}`,
          `   Balance:        $${b.credits_remaining_usd.toFixed(4)} / $${b.total_credits_usd.toFixed(2)} (${pctUsed}% used)`,
          ``,
          `   Current month:`,
          `     Requests:     ${cm.requests}`,
          `     Tokens:       ${cm.tokens.toLocaleString()}`,
          `     Energy:       ${formatEnergy(cm.energy_kwh)}`,
          `     Cost:         $${cm.cost_usd.toFixed(4)}`,
        ];
        if (lt.requests !== cm.requests) {
          lines.push(
            ``,
            `   Lifetime:`,
            `     Requests:     ${lt.requests}`,
            `     Tokens:       ${lt.tokens.toLocaleString()}`,
            `     Energy:       ${formatEnergy(lt.energy_kwh)}`,
            `     Cost:         $${lt.cost_usd.toFixed(4)}`,
          );
        }
        if (data.limits.rate_limit_tier) {
          lines.push(``, `   Rate limit:     ${data.limits.rate_limit_tier}`);
        }
        lines.push(``, `   As of ${data.snapshot_at}`);
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to fetch quota data: ${err.message}`, "error");
      }
    },
  });

  // Command /neuralwatt:toggle.
  pi.registerCommand("neuralwatt:toggle", {
    description: "Toggle the Neuralwatt status bar on or off",
    handler: async (_args, ctx) => {
      state.statusBarEnabled = !state.statusBarEnabled;
      await writeState(state);
      if (state.statusBarEnabled) {
        lastStatusUpdate = 0;
        await refreshStatus(ctx);
      } else {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      ctx.ui.notify(`Neuralwatt status bar ${state.statusBarEnabled ? "enabled" : "disabled"}`, "info");
    },
  });
}

// ─── Model Catalog ─────────────────────────────────────────────────

/** (Re-)register the neuralwatt provider with the given model list. */
function registerModels(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider("neuralwatt", {
    baseUrl: BASE_URL,
    apiKey: "$NEURALWATT_API_KEY",
    api: "openai-completions",
    models,
  });
}

/** Return the catalog, refetching from /v1/models when stale or `force`d. Concurrent calls share one refresh. */
async function ensureModels(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { force: boolean },
): Promise<ProviderModelConfig[]> {
  if (refreshInFlight) return refreshInFlight;
  if (!opts.force && state.modelsExpireAt !== null && Date.now() < state.modelsExpireAt) {
    return state.models ?? []; // Fresh catalog; already registered by the factory.
  }
  refreshInFlight = refreshModels(pi, ctx).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Refresh the catalog and re-register the provider; fall back to the stale list on failure. */
async function refreshModels(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ProviderModelConfig[]> {
  try {
    const models = await fetchModels(ctx);
    registerModels(pi, models);
    return models;
  } catch (err) {
    // Network/API failure: keep using whatever the factory already registered.
    // A stale list beats none; /neuralwatt:refresh reports the fallback.
    if (state.models?.length) return state.models;
    throw err;
  }
}

/** Fetch /v1/models (auth optional), map to ProviderModelConfig[], and cache with a Cache-Control-derived expiry. */
async function fetchModels(ctx: ExtensionContext): Promise<ProviderModelConfig[]> {
  const res = await apiFetch(ctx, "/models");
  if (!res.ok) throw new Error(`/v1/models returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: ApiModel[] };
  const entries = body.data ?? [];
  if (!entries.length) throw new Error("/v1/models returned empty list");

  const modelsExpireAt = parseCacheExpiry(res.headers.get("cache-control"));
  const effort = buildEffortMapIndex(ctx);
  const models = buildModels(entries, effort);

  state = { ...state, modelsFetchedAt: Date.now(), modelsExpireAt, models };
  await writeState(state);
  return models;
}

/** Compute the cache expiry timestamp from a Cache-Control header. */
function parseCacheExpiry(header: string | null): number {
  if (!header) return Date.now() + DEFAULT_CACHE_TTL_MS;
  const directives = header.toLowerCase().split(",").map((d) => d.trim());
  // Treat no-store/no-cache as immediately stale (still cached so cold starts have a fallback).
  if (directives.some((d) => d === "no-store" || d === "no-cache")) return Date.now();
  const maxAge = (name: string): number | undefined => {
    const d = directives.find((dir) => dir.startsWith(`${name}=`));
    if (!d) return undefined;
    const n = Number(d.slice(name.length + 1));
    return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
  };
  // Prefer s-maxage (shared cache) over max-age (client cache).
  return Date.now() + (maxAge("s-maxage") ?? maxAge("max-age") ?? DEFAULT_CACHE_TTL_MS);
}

/**
 * Index pi's built-in {modelId → thinkingLevelMap} so Neuralwatt models reuse the
 * curated effort renames for the same id (e.g. GLM-5.2: xhigh → max). Skips maps
 * that only pass levels through, and off:null maps (Neuralwatt can always disable
 * reasoning); excludes neuralwatt's own entries to avoid stale self-reference.
 */
function buildEffortMapIndex(ctx: ExtensionContext): Map<string, ThinkingLevelMap> {
  const index = new Map<string, ThinkingLevelMap>();
  for (const m of ctx.modelRegistry.getAll()) {
    if (m.provider === "neuralwatt") continue;
    const map = m.thinkingLevelMap;
    if (!map || map.off === null) continue;
    const remaps = Object.entries(map).some(
      ([level, value]) => typeof value === "string" && value !== level,
    );
    if (!remaps) continue;
    if (!index.has(m.id)) index.set(m.id, map);
  }
  return index;
}

/** Convert /v1/models entries into pi ProviderModelConfig objects. */
function buildModels(
  entries: ApiModel[],
  effort: Map<string, ThinkingLevelMap>,
): ProviderModelConfig[] {
  return entries.map((m) => {
    const caps = m.metadata?.capabilities;
    const pricing = m.metadata?.pricing;
    const reasoning = caps?.reasoning === true;
    const cost: ProviderModelConfig["cost"] = pricing?.pricing_tbd
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : {
          input: asPrice(pricing?.input_per_million),
          output: asPrice(pricing?.output_per_million),
          cacheRead: asPrice(pricing?.cached_input_per_million),
          cacheWrite: asPrice(pricing?.cached_output_per_million),
        };
    // Only force a compat flag off from capabilities; developer role stays off unless the API confirms it.
    const compat: ProviderModelConfig["compat"] = {
      ...(reasoning && caps?.reasoning_effort === false ? { supportsReasoningEffort: false } : {}),
      ...(caps?.developer_role !== true ? { supportsDeveloperRole: false } : {}),
    };
    return {
      id: m.id,
      name: formatName(m.id, m.owned_by),
      reasoning,
      thinkingLevelMap: reasoning ? effort.get(m.id) : undefined,
      compat: Object.keys(compat).length ? compat : undefined,
      input: ["text"],
      contextWindow: m.max_model_len ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: m.metadata?.limits?.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      cost,
    };
  });
}

async function readState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<State>;
    return {
      statusBarEnabled: parsed?.statusBarEnabled === true,
      modelsFetchedAt: typeof parsed?.modelsFetchedAt === "number" ? parsed.modelsFetchedAt : null,
      modelsExpireAt: typeof parsed?.modelsExpireAt === "number" ? parsed.modelsExpireAt : null,
      models: Array.isArray(parsed?.models) ? (parsed.models as ProviderModelConfig[]) : null,
    };
  } catch {
    // Missing or unreadable state file → cold start with EMPTY_STATE.
    return { ...EMPTY_STATE };
  }
}

async function writeState(next: State): Promise<void> {
  try {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(next, null, 2));
  } catch {
    // Best-effort: the in-memory state still applies for the current session.
  }
}

// ─── Status Bar ────────────────────────────────────────────────────

async function refreshStatus(ctx: ExtensionContext) {
  // The status bar is opt-in; /neuralwatt:toggle enables it.
  if (!state.statusBarEnabled) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  // Only show the banner while a neuralwatt model is active.
  if (ctx.model?.provider !== "neuralwatt") {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const now = Date.now();
  if (now - lastStatusUpdate < STATUS_UPDATE_MIN_INTERVAL) return;

  const muted = (s: string) => ctx.ui.theme.fg("muted", s);
  try {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
    if (!apiKey) {
      ctx.ui.setStatus(STATUS_KEY, muted(`⚡no API key configured for neuralwatt`));
      return;
    }
    const res = await apiFetch(ctx, "/quota");
    if (!res.ok) {
      ctx.ui.setStatus(STATUS_KEY, muted(`⚡neuralwatt fetch error (${res.status})`));
      return;
    }
    const data: QuotaResponse = await res.json();
    const b = data.balance;
    const cm = data.usage.current_month;
    ctx.ui.setStatus(
      STATUS_KEY,
      muted(`⚡$${b.credits_remaining_usd.toFixed(2)}/$${b.total_credits_usd.toFixed(2)} left · ${cm.requests} requests · ${formatEnergy(cm.energy_kwh)} used · $${cm.cost_usd.toFixed(2)} spent this month`),
    );
    lastStatusUpdate = Date.now();
  } catch {
    // Leave lastStatusUpdate untouched so the next call retries sooner.
    ctx.ui.setStatus(STATUS_KEY, muted(`⚡neuralwatt offline`));
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** GET the Neuralwatt API, sending a Bearer token when a key is set (/v1/models works without one).
 *  `requireAuth` fails fast on endpoints that need a key. */
async function apiFetch(
  ctx: ExtensionContext,
  path: string,
  opts: { requireAuth?: boolean } = {},
): Promise<Response> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
  if (opts.requireAuth && !apiKey) throw new Error("No API key configured for neuralwatt");
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return fetch(`${BASE_URL}${path}`, { headers });
}

/** Authenticated GET that throws on missing key or HTTP error and returns JSON. */
async function apiGet<T>(ctx: ExtensionContext, path: string): Promise<T> {
  const res = await apiFetch(ctx, path, { requireAuth: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const asPrice = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);

function formatName(id: string, ownedBy?: string): string {
  if (ownedBy === "neuralwatt") {
    return id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) + " (NW Fast)";
  }
  const model = id.includes("/") ? id.split("/").pop()! : id;
  return model.replace(/-/g, " ").replace(/Instruct.*$/i, "").replace(/\bFP8\b/gi, "").trim() + " (Neuralwatt)";
}

// Scale Wh into the most readable unit (µWh / mWh / kWh).
function formatEnergy(kwh: number): string {
  if (kwh < 0.001) return `${(kwh * 1_000_000).toFixed(2)} µWh`;
  if (kwh < 1) return `${(kwh * 1_000).toFixed(2)} mWh`;
  return `${kwh.toFixed(4)} kWh`;
}

// ─── Types ──────────────────────────────────────────────────────────

interface State {
  statusBarEnabled: boolean;
  modelsFetchedAt: number | null;
  modelsExpireAt: number | null;
  models: ProviderModelConfig[] | null;
}

interface ApiModel {
  id: string;
  max_model_len?: number;
  owned_by?: string;
  metadata?: {
    capabilities?: {
      reasoning?: boolean;
      reasoning_effort?: boolean;
      developer_role?: boolean;
    };
    pricing?: {
      pricing_tbd?: boolean;
      input_per_million?: number;
      output_per_million?: number;
      cached_input_per_million?: number;
      cached_output_per_million?: number;
    };
    limits?: { max_output_tokens?: number };
  };
}

interface EnergyResponse {
  period: { start: string; end: string };
  totals: { requests: number; energy_kwh: number; energy_joules: number };
  daily?: Array<{ date: string; requests: number; energy_kwh: number }>;
}

interface QuotaResponse {
  snapshot_at: string;
  balance: {
    credits_remaining_usd: number;
    total_credits_usd: number;
    credits_used_usd: number;
    accounting_method: string;
  };
  usage: { lifetime: UsageBlock; current_month: UsageBlock };
  limits: { rate_limit_tier: string };
  key: { name: string };
}

interface UsageBlock {
  cost_usd: number;
  requests: number;
  tokens: number;
  energy_kwh: number;
}
