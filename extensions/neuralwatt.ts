import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ─── Configuration ──────────────────────────────────────────────────
const BASE_URL = "https://api.neuralwatt.com/v1";
const ENERGY_RATE_PER_KWH = 5.0; // USD
const STATUS_KEY = "neuralwatt";

// Rate limiting for status refreshes
let lastStatusUpdate = 0;
const STATUS_UPDATE_MIN_INTERVAL = 15000; // 15 seconds

// Models where pi can send reasoning-specific API params
// Populated dynamically from /v1/models `capabilities.reasoning` at session
// start (see fetchAndRegister), and reassigned on each successful model fetch
let REASONING_MODELS = new Set<string>();

// Override max output tokens for models with small context windows
const MAX_TOKENS_OVERRIDE: Record<string, number> = {
  "openai/gpt-oss-20b": 8192,
};

const DEFAULT_MAX_TOKENS = 32768;

// Drived from ProviderModelConfig so it tracks pi's Model type
type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

// ─── Extension Entry Point ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Register fallback models immediately
  registerFallback(pi);

  pi.on("session_start", async (event, ctx) => {
    // Skip live registration except on startup and reload.
    if (event.reason !== 'startup' && event.reason !== 'reload') {
      return;
    }

    try {
      await fetchAndRegister(pi, ctx);
    } catch (err) {
      const error = err as Error;
      ctx.ui.notify(`[neuralwatt] Model fetch failed, using fallback: ${error.message}`, "error");
    }
    await refreshStatus(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  // Refresh after each LLM turn completes (a request was just billed)
  pi.on("turn_end", async (_event, ctx) => {
    try {
      await refreshStatus(ctx);
    } catch {
      // Silent fail - don't spam with status errors per turn
    }
  });

  // Await refreshStatus on model_select event
  pi.on("model_select", async (_event, ctx) => {
    lastStatusUpdate = 0;
    await refreshStatus(ctx);
  });

  // ─── Slash Commands ─────────────────────────────────────────────

  // /energy — Show energy usage breakdown
  pi.registerCommand("energy", {
    description: "Show Neuralwatt energy consumption stats",
    handler: async (_args, ctx) => {
      try {
        const key = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
        if (!key) throw new Error("No API key configured for neuralwatt");
        const res = await fetch(`${BASE_URL}/usage/energy`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: EnergyResponse = await res.json();

        const lines: string[] = [];
        lines.push(`⚡ Neuralwatt Energy Usage`);
        lines.push(`   Period: ${data.period.start} → ${data.period.end}`);
        lines.push(``);
        lines.push(`   Requests:      ${data.totals.requests}`);
        lines.push(`   Energy:        ${formatEnergy(data.totals.energy_kwh)}`);
        lines.push(`   Energy (J):    ${data.totals.energy_joules.toFixed(2)} J`);
        lines.push(`   Est. cost:     $${(data.totals.energy_kwh * ENERGY_RATE_PER_KWH).toFixed(4)}`);

        if (data.daily && data.daily.length > 0) {
          lines.push(``);
          lines.push(`   Daily breakdown (last ${Math.min(data.daily.length, 7)} days):`);
          const recent = data.daily.slice(0, 7);
          for (const day of recent) {
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

  // /quota — Show account balance and usage
  pi.registerCommand("quota", {
    description: "Show Neuralwatt account balance and quota",
    handler: async (_args, ctx) => {
      try {
        const key = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
        if (!key) throw new Error("No API key configured for neuralwatt");
        const res = await fetch(`${BASE_URL}/quota`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: QuotaResponse = await res.json();

        const b = data.balance;
        const pctUsed = ((b.credits_used_usd / b.total_credits_usd) * 100).toFixed(1);

        const lines: string[] = [];
        lines.push(`💰 Neuralwatt Account`);
        lines.push(`   Key:            ${data.key.name}`);
        lines.push(`   Method:         ${b.accounting_method}`);
        lines.push(`   Balance:        $${b.credits_remaining_usd.toFixed(4)} / $${b.total_credits_usd.toFixed(2)} (${pctUsed}% used)`);
        lines.push(``);

        const cm = data.usage.current_month;
        lines.push(`   Current month:`);
        lines.push(`     Requests:     ${cm.requests}`);
        lines.push(`     Tokens:       ${cm.tokens.toLocaleString()}`);
        lines.push(`     Energy:       ${formatEnergy(cm.energy_kwh)}`);
        lines.push(`     Cost:         $${cm.cost_usd.toFixed(4)}`);

        const lt = data.usage.lifetime;
        if (lt.requests !== cm.requests) {
          lines.push(``);
          lines.push(`   Lifetime:`);
          lines.push(`     Requests:     ${lt.requests}`);
          lines.push(`     Tokens:       ${lt.tokens.toLocaleString()}`);
          lines.push(`     Energy:       ${formatEnergy(lt.energy_kwh)}`);
          lines.push(`     Cost:         $${lt.cost_usd.toFixed(4)}`);
        }

        if (data.limits.rate_limit_tier) {
          lines.push(``);
          lines.push(`   Rate limit:     ${data.limits.rate_limit_tier}`);
        }

        lines.push(``);
        lines.push(`   As of ${data.snapshot_at}`);

        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to fetch quota data: ${err.message}`, "error");
      }
    },
  });
}

// ─── Status Bar Helper ──────────────────────────────────────────────

async function refreshStatus(ctx: ExtensionContext) {

  // Show the neuralwatt banner only when a neuralwatt model is used
  if (ctx.model?.provider !== "neuralwatt") {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const now = Date.now();
  if (now - lastStatusUpdate < STATUS_UPDATE_MIN_INTERVAL) {
    return;
  }

  const t = ctx.ui.theme;
  try {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
    if (!apiKey) {
      ctx.ui.setStatus(STATUS_KEY, t.fg("muted", `⚡no API key configured for neuralwatt`));
      return;
    }
    const res = await fetch(`${BASE_URL}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      ctx.ui.setStatus(STATUS_KEY, t.fg("muted", `⚡neuralwatt fetch error (${res.status})`));
      return;
    }
    const data: QuotaResponse = await res.json();

    const bal = data.balance.credits_remaining_usd;
    const total = data.balance.total_credits_usd;
    const reqs = data.usage.current_month.requests;
    const energy = formatEnergy(data.usage.current_month.energy_kwh);
    const cost = data.usage.current_month.cost_usd;

    ctx.ui.setStatus(
      STATUS_KEY,
      t.fg("muted", `⚡$${bal.toFixed(2)}/$${total.toFixed(2)} left · ${reqs} requests · ${energy} used · $${cost.toFixed(4)} spent`),
    );
    lastStatusUpdate = Date.now();
  } catch {
    // Don't update lastStatusUpdate on failure to allow retry sooner
    ctx.ui.setStatus(STATUS_KEY, t.fg("muted", `⚡neuralwatt offline`));
  }
}

// ─── Model Registration ─────────────────────────────────────────────

async function fetchAndRegister(pi: ExtensionAPI, ctx: ExtensionContext) {
  // Query models with auth when an API key is available (e.g. after
  // /login); otherwise fall back to the unauthenticated endpoint
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${BASE_URL}/models`, { headers });
  if (!res.ok) throw new Error(`/v1/models returned ${res.status}`);

  const body = await res.json();
  const entries: ModelEntry[] = body.data ?? [];
  if (entries.length === 0) throw new Error("/v1/models returned empty list");

  // Derive reasoning-capable model IDs from the API's capability metadata
  REASONING_MODELS = new Set(
    entries
      .filter((m) => m.metadata?.capabilities?.reasoning === true)
      .map((m) => m.id),
  );

  // Reuse pi's curated per-model effort-name mappings (e.g. GLM-5.2 maps
  // xhigh to max) so neuralwatt models speak the same effort vocabulary pi
  // already knows for that model id. Looked up from the built-in catalog
  const effortMapById = buildEffortMapIndex(ctx);

  // Convert /v1/models per-million USD pricing to pi's per-million cost
  const perMillion = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);

  const models: ProviderModelConfig[] = entries.map((m) => {
    const reasoning = REASONING_MODELS.has(m.id);
    const caps = m.metadata?.capabilities;
    const p = m.metadata?.pricing;
    const cost: ProviderModelConfig["cost"] = p?.pricing_tbd
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : {
          input: perMillion(p?.input_per_million),
          output: perMillion(p?.output_per_million),
          cacheRead: perMillion(p?.cached_input_per_million),
          cacheWrite: perMillion(p?.cached_output_per_million),
        };
    const compat: ProviderModelConfig["compat"] = {
      ...(reasoning && caps?.reasoning_effort === false ? { supportsReasoningEffort: false } : {}),
      ...(caps?.developer_role !== true ? { supportsDeveloperRole: false } : {}),
    };
    return {
      id: m.id,
      name: formatName(m.id, m.owned_by),
      reasoning,
      thinkingLevelMap: reasoning ? effortMapById.get(m.id) : undefined,
      compat: Object.keys(compat).length ? compat : undefined,
      input: ["text"] as const,
      contextWindow: m.max_model_len ?? 131072,
      maxTokens: MAX_TOKENS_OVERRIDE[m.id] ?? DEFAULT_MAX_TOKENS,
      cost,
    };
  });

  pi.registerProvider("neuralwatt", {
    baseUrl: BASE_URL,
    apiKey: "$NEURALWATT_API_KEY",
    api: "openai-completions",
    models,
  });

  ctx.ui.notify(`[neuralwatt] Registered ${models.length} models: ${models.map((m) => m.id).join(", ")}`);
}

function registerFallback(pi: ExtensionAPI) {
  pi.registerProvider("neuralwatt", {
    baseUrl: BASE_URL,
    apiKey: "$NEURALWATT_API_KEY",
    api: "openai-completions",
    models: [
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", reasoning: true, input: ["text"], contextWindow: 262128, maxTokens: 32768, cost: { input: 0.95, output: 4.0, cacheRead: 0.2375, cacheWrite: 0 }, compat: { supportsReasoningEffort: false, supportsDeveloperRole: false } },
      { id: "kimi-k2.6", name: "Kimi K2.6", reasoning: true, input: ["text"], contextWindow: 262128, maxTokens: 32768, cost: { input: 0.69, output: 3.22, cacheRead: 0.1725, cacheWrite: 0 }, compat: { supportsReasoningEffort: false, supportsDeveloperRole: false } },
      { id: "kimi-k2.6-fast", name: "Kimi K2.6 Fast", reasoning: false, input: ["text"], contextWindow: 262128, maxTokens: 32768, cost: { input: 0.69, output: 3.22, cacheRead: 0.1725, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } },
      { id: "qwen3.5-397b", name: "Qwen3.5 397B", reasoning: true, input: ["text"], contextWindow: 262128, maxTokens: 32768, cost: { input: 0.69, output: 4.14, cacheRead: 0.1725, cacheWrite: 0 }, compat: { supportsReasoningEffort: false, supportsDeveloperRole: false } },
      { id: "qwen3.5-397b-fast", name: "Qwen3.5 397B Fast", reasoning: false, input: ["text"], contextWindow: 262128, maxTokens: 32768, cost: { input: 0.69, output: 4.14, cacheRead: 0.1725, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } },
      { id: "glm-5.2", name: "GLM-5.2", reasoning: true, input: ["text"], contextWindow: 1048560, maxTokens: 32768, cost: { input: 1.45, output: 4.5, cacheRead: 0.3625, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } },
      { id: "glm-5.2-fast", name: "GLM-5.2 (fast)", reasoning: false, input: ["text"], contextWindow: 1048560, maxTokens: 32768, cost: { input: 1.45, output: 4.5, cacheRead: 0.3625, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } },
      { id: "glm-5.2-short", name: "GLM-5.2 (short)", reasoning: true, input: ["text"], contextWindow: 199984, maxTokens: 32768, cost: { input: 1.45, output: 4.5, cacheRead: 0.3625, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } },
      { id: "glm-5.2-short-fast", name: "GLM-5.2 (short, fast)", reasoning: false, input: ["text"], contextWindow: 199984, maxTokens: 32768, cost: { input: 1.45, output: 4.5, cacheRead: 0.3625, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } },
      { id: "qwen3.6-35b", name: "Qwen3.6 35B", reasoning: true, input: ["text"], contextWindow: 131056, maxTokens: 32768, cost: { input: 0.29, output: 1.15, cacheRead: 0.0725, cacheWrite: 0 }, compat: { supportsReasoningEffort: false, supportsDeveloperRole: false } },
      { id: "qwen3.6-35b-fast", name: "Qwen3.6 35B Fast", reasoning: false, input: ["text"], contextWindow: 131056, maxTokens: 32768, cost: { input: 0.29, output: 1.15, cacheRead: 0.0725, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } },
    ],
  });
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatName(id: string, ownedBy?: string): string {
  if (ownedBy === "neuralwatt") {
    return id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) + " (NW Fast)";
  }
  const model = id.includes("/") ? id.split("/").pop()! : id;
  return (
    model
      .replace(/-/g, " ")
      .replace(/Instruct.*$/i, "")
      .replace(/\bFP8\b/gi, "")
      .trim() + " (Neuralwatt)"
  );
}

function formatEnergy(kwh: number): string {
  if (kwh < 0.001) return `${(kwh * 1_000_000).toFixed(2)} µWh`;
  if (kwh < 1) return `${(kwh * 1_000).toFixed(2)} mWh`;
  return `${kwh.toFixed(4)} kWh`;
}

/**
 * Build a {modelId → thinkingLevelMap} index from pi's built-in model catalog
 * (ctx.modelRegistry), so neuralwatt models can reuse the curated effort-name
 * mappings pi already defines for the same model id (GLM-5.2: xhigh to max).
 *
 * Only maps that actually rename an effort level are carried over, and maps
 * that disable the "off" level (off: null) are skipped - neuralwatt reasoning
 * models always allow turning reasoning off (e.g. via reasoning_effort=none),
 * so an off:null marker (provider-specific plumbing where a gateway always
 * reasons) must not be imposed on the neuralwatt proxy. Neuralwatt's own prior
 * registrations are excluded to avoid self-reference.
 */
function buildEffortMapIndex(ctx: ExtensionContext): Map<string, ThinkingLevelMap> {
  const index = new Map<string, ThinkingLevelMap>();
  for (const m of ctx.modelRegistry.getAll()) {
    if (m.provider === "neuralwatt") continue;
    const map = m.thinkingLevelMap;
    if (!map) continue;
    if (map.off === null) continue;
    const remaps = Object.entries(map).some(
      ([level, value]) => typeof value === "string" && value !== level,
    );
    if (!remaps) continue;
    if (!index.has(m.id)) index.set(m.id, map);
  }
  return index;
}

// ─── Types ──────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  max_model_len?: number;
  owned_by?: string;
  [k: string]: any;
}

interface EnergyResponse {
  period: { start: string; end: string };
  totals: {
    requests: number;
    requests_with_energy: number;
    energy_kwh: number;
    energy_joules: number;
  };
  daily?: Array<{
    date: string;
    requests: number;
    requests_with_energy: number;
    energy_kwh: number;
    energy_joules: number;
  }>;
}

interface QuotaResponse {
  snapshot_at: string;
  balance: {
    credits_remaining_usd: number;
    total_credits_usd: number;
    credits_used_usd: number;
    accounting_method: string;
  };
  usage: {
    lifetime: UsageBlock;
    current_month: UsageBlock;
  };
  limits: {
    overage_limit_usd: number | null;
    rate_limit_tier: string;
  };
  subscription: any;
  key: { name: string; allowance: any };
}

interface UsageBlock {
  cost_usd: number;
  requests: number;
  tokens: number;
  energy_kwh: number;
}
