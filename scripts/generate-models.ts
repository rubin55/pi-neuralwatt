/**
 * Generate extensions/neuralwatt.models.ts from Neuralwatt's /v1/models.
 *
 * Mirrors pi's own scripts/generate-models.ts: snapshots the live model list
 * (pricing, context window, capabilities) into a static catalog, and sources
 * each model's thinkingLevelMap from pi's curated built-in catalogs (matched by
 * model id) — the one piece /v1/models cannot provide.
 *
 * Run: `bun run scripts/generate-models.ts` (requires @earendil-works/pi-coding-agent
 * installed, which bundles @earendil-works/pi-ai).
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.neuralwatt.com/v1";

// Fallbacks when /v1/models omits the field
const DEFAULT_CONTEXT_WINDOW = 131072; // 128k
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

const OUT = fileURLToPath(new URL("../extensions/neuralwatt.models.ts", import.meta.url));

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

// Locate @earendil-works/pi-ai's providers dir wherever it lives under
// node_modules/@earendil-works (handles both hoisted and nested installs).
async function findPiAiProviders(): Promise<string> {
  for (const root of ["node_modules/@earendil-works", "node_modules"]) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      if (!existsSync(dir)) continue;
      const cand = join(dir, "@earendil-works/pi-ai/dist/providers");
      if (existsSync(join(cand, "zai.models.js"))) return cand;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) stack.push(join(dir, e.name));
      }
    }
  }
  throw new Error("Could not find @earendil-works/pi-ai; install @earendil-works/pi-coding-agent first.");
}

// Build {modelId → thinkingLevelMap} from pi's curated built-in catalogs.
// Mirrors the runtime buildEffortMapIndex: skip maps where `off: null`
// (gateway-always-on; neuralwatt allows reasoning off) and maps that don't
// actually remap a level.
async function buildEffortMapIndex(): Promise<Map<string, Record<string, string | null>>> {
  const dir = await findPiAiProviders();
  const index = new Map<string, Record<string, string | null>>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".models.js")) continue;
    const mod: Record<string, unknown> = await import(pathToFileURL(join(dir, file)).href);
    for (const exported of Object.values(mod)) {
      if (!exported || typeof exported !== "object") continue;
      for (const m of Object.values(exported as Record<string, any>)) {
        if (!m || m.provider === "neuralwatt") continue;
        const map = m.thinkingLevelMap;
        if (!map || map.off === null) continue;
        const remaps = Object.entries(map).some(
          ([lvl, val]: [string, unknown]) => typeof val === "string" && val !== lvl,
        );
        if (remaps && !index.has(m.id)) index.set(m.id, map);
      }
    }
  }
  return index;
}

async function fetchModels(): Promise<ApiModel[]> {
  const res = await fetch(`${BASE_URL}/models`);
  if (!res.ok) throw new Error(`/v1/models returned ${res.status}`);
  const body = (await res.json()) as { data?: ApiModel[] };
  const entries = body.data ?? [];
  if (!entries.length) throw new Error("/v1/models returned empty list");
  return entries;
}

function formatName(id: string, ownedBy?: string): string {
  if (ownedBy === "neuralwatt") {
    return id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) + " (NW Fast)";
  }
  const model = id.includes("/") ? id.split("/").pop()! : id;
  return model.replace(/-/g, " ").replace(/Instruct.*$/i, "").replace(/\bFP8\b/gi, "").trim() + " (Neuralwatt)";
}

const asPrice = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);

/** Format a value as TS so the generated file reads exactly like pi's catalogs. */
function ts(v: unknown, indent: string): string {
  if (Array.isArray(v) || (v && typeof v === "object")) {
    return JSON.stringify(v, null, 2).replace(/\n/g, "\n" + indent);
  }
  return JSON.stringify(v);
}

function buildModels(entries: ApiModel[], effort: Map<string, Record<string, string | null>>): ProviderModelConfig[] {
  return entries.map((m) => {
    const caps = m.metadata?.capabilities;
    const p = m.metadata?.pricing;
    const reasoning = caps?.reasoning === true;
    const cost: ProviderModelConfig["cost"] = p?.pricing_tbd
      ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : {
          input: asPrice(p?.input_per_million),
          output: asPrice(p?.output_per_million),
          cacheRead: asPrice(p?.cached_input_per_million),
          cacheWrite: asPrice(p?.cached_output_per_million),
        };
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
    } as ProviderModelConfig;
  });
}

function emit(models: ProviderModelConfig[]): string {
  const lines = [
    "// This file is auto-generated by scripts/generate-models.ts — do not edit manually.",
    "// Run `bun run scripts/generate-models.ts` to regenerate from https://api.neuralwatt.com/v1/models",
    "import type { ProviderModelConfig } from \"@earendil-works/pi-coding-agent\";",
    "",
    "export const NEURALWATT_MODELS: Record<string, ProviderModelConfig> = {",
  ];
  for (const m of models) {
    lines.push(`  ${JSON.stringify(m.id)}: {`);
    for (const [k, v] of Object.entries(m)) {
      if (v === undefined) continue;
      lines.push(`    ${k}: ${ts(v, "    ")},`);
    }
    lines.push("  },");
  }
  lines.push("};");
  return lines.join("\n") + "\n";
}

// ─── main ───────────────────────────────────────────────────────────

const [entries, effort] = await Promise.all([fetchModels(), buildEffortMapIndex()]);
const models = buildModels(entries, effort);

writeFileSync(OUT, emit(models));
console.log(`Generated ${models.length} models → ${OUT}`);
for (const m of models) {
  console.log(`  ${m.id}${m.thinkingLevelMap ? ` (thinkingLevelMap: ${JSON.stringify(m.thinkingLevelMap)})` : ""}`);
}
