import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

// ─── Configuration ──────────────────────────────────────────────────
const BASE_URL = "https://api.neuralwatt.com/v1";
const ENERGY_RATE_PER_KWH = 5.0; // USD
const STATUS_KEY = "neuralwatt";

// Models where pi can safely send reasoning-specific API params
// (reasoning_effort, developer role, max_completion_tokens).
// Most vLLM-hosted models reject these — only add IDs you've verified.
const REASONING_MODELS = new Set<string>([
  // "zai-org/GLM-5.1-FP8",  // uncomment after testing with --thinking medium
]);

// Override max output tokens for models with small context windows
const MAX_TOKENS_OVERRIDE: Record<string, number> = {
  "openai/gpt-oss-20b": 8192,
};

const DEFAULT_MAX_TOKENS = 32768;

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

  // ─── Status Bar ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  // Refresh after each LLM turn completes (a request was just billed)
  pi.on("turn_end", async (_event, ctx) => {
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
  try {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
    if (!apiKey) {
      ctx.ui.setStatus(STATUS_KEY, `⚡ NW: no API key`);
      return;
    }
    const res = await fetch(`${BASE_URL}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      ctx.ui.setStatus(STATUS_KEY, `⚡ NW: fetch error (${res.status})`);
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
      `⚡ NW: $${bal.toFixed(2)}/$${total.toFixed(2)} | ${reqs} reqs | ${energy} | $${cost.toFixed(4)} spent`
    );
  } catch {
    ctx.ui.setStatus(STATUS_KEY, `⚡ NW: offline`);
  }
}

// ─── Model Registration ─────────────────────────────────────────────

async function fetchAndRegister(pi: ExtensionAPI, ctx: ExtensionContext) {
  const res = await fetch(`${BASE_URL}/models`);
  if (!res.ok) throw new Error(`/v1/models returned ${res.status}`);

  const body = await res.json();
  const entries: ModelEntry[] = body.data ?? [];
  if (entries.length === 0) throw new Error("/v1/models returned empty list");

  const models: ProviderModelConfig[] = entries.map((m) => ({
    id: m.id,
    name: formatName(m.id, m.owned_by),
    reasoning: REASONING_MODELS.has(m.id),
    input: ["text"] as const,
    contextWindow: m.max_model_len ?? 131072,
    maxTokens: MAX_TOKENS_OVERRIDE[m.id] ?? DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));

  pi.registerProvider("neuralwatt", {
    baseUrl: BASE_URL,
    apiKey: "NEURALWATT_API_KEY",
    api: "openai-completions",
    models,
  });

  ctx.ui.notify(`[neuralwatt] Registered ${models.length} models: ${models.map((m) => m.id).join(", ")}`);
}

function registerFallback(pi: ExtensionAPI) {
  pi.registerProvider("neuralwatt", {
    baseUrl: BASE_URL,
    apiKey: "NEURALWATT_API_KEY",
    api: "openai-completions",
    models: [
      { id: "mistralai/Devstral-Small-2-24B-Instruct-2512", name: "Devstral Small 2 24B (Neuralwatt)", reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "zai-org/GLM-5.1-FP8", name: "GLM 5.1 (Neuralwatt)", reasoning: false, input: ["text"], contextWindow: 202752, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "Qwen/Qwen3.5-397B-A17B-FP8", name: "Qwen3.5 397B (Neuralwatt)", reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5 (Neuralwatt)", reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5 (Neuralwatt)", reasoning: false, input: ["text"], contextWindow: 196608, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B (Neuralwatt)", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "Qwen/Qwen3.5-35B-A3B", name: "Qwen3.5 35B (Neuralwatt)", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
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
