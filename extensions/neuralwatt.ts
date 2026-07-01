import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NEURALWATT_MODELS } from "./neuralwatt.models";

// ─── Configuration ──────────────────────────────────────────────────

const BASE_URL = "https://api.neuralwatt.com/v1";
const STATUS_KEY = "neuralwatt";

// USD per kWh — source: https://portal.neuralwatt.com/energy-pricing
const ENERGY_RATE_PER_KWH = 5.0;

// Cap status-bar refreshes at one per 60s to spare the API
const STATUS_UPDATE_MIN_INTERVAL = 60_000;

// How many recent days the /energy daily breakdown shows
const RECENT_DAYS = 7;

// Initialize lastStatusUpdate to zero
let lastStatusUpdate = 0;

// Whether the status-bar widget is shown by default
let statusBarEnabled = false;

// ─── Entry Point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerProvider("neuralwatt", {
    baseUrl: BASE_URL,
    apiKey: "$NEURALWATT_API_KEY",
    api: "openai-completions",
    models: Object.values(NEURALWATT_MODELS),
  });

  // Refresh on initial session start
  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  // Refresh after each LLM turn
  pi.on("turn_end", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  // On model switch, reset last status update to zero
  pi.on("model_select", async (_event, ctx) => {
    lastStatusUpdate = 0;
    await refreshStatus(ctx);
  });

  // Command: /neuralwatt:energy - energy consumption breakdown
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

  // Command /neuralwatt:quota - account balance and usage
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

  // Command /neuralwatt:toggle - enable/disable the status-bar widget (default disabled)
  pi.registerCommand("neuralwatt:toggle", {
    description: "Toggle the Neuralwatt status bar on or off",
    handler: async (_args, ctx) => {
      statusBarEnabled = !statusBarEnabled;
      if (statusBarEnabled) {
        lastStatusUpdate = 0;
        await refreshStatus(ctx);
      } else {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      ctx.ui.notify(`Neuralwatt status bar ${statusBarEnabled ? "enabled" : "disabled"}`, "info");
    },
  });
}

// ─── Status Bar ────────────────────────────────────────────────────

async function refreshStatus(ctx: ExtensionContext) {
  // The status bar is opt-in; /neuralwatt:toggle enables it.
  if (!statusBarEnabled) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  // Only show the banner while a neuralwatt model is active
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
    const res = await fetch(`${BASE_URL}/quota`, { headers: { Authorization: `Bearer ${apiKey}` } });
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
    // Leave lastStatusUpdate untouched so the next call retries sooner
    ctx.ui.setStatus(STATUS_KEY, muted(`⚡neuralwatt offline`));
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Authenticated GET against the Neuralwatt API; throws on missing key or HTTP error. */
async function apiGet<T>(ctx: ExtensionContext, path: string): Promise<T> {
  const key = await ctx.modelRegistry.getApiKeyForProvider("neuralwatt");
  if (!key) throw new Error("No API key configured for neuralwatt");
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// Scale Wh into the most readable unit (µWh / mWh / kWh)
function formatEnergy(kwh: number): string {
  if (kwh < 0.001) return `${(kwh * 1_000_000).toFixed(2)} µWh`;
  if (kwh < 1) return `${(kwh * 1_000).toFixed(2)} mWh`;
  return `${kwh.toFixed(4)} kWh`;
}

// ─── Types ──────────────────────────────────────────────────────────

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
