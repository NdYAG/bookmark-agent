import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ModelLimitSchema = z.object({
  rpm: z.number().int().positive(),
  tpm: z.number().int().positive(),
  rpd: z.number().int().positive(),
});

export type ModelLimit = z.infer<typeof ModelLimitSchema>;

// Rate limit presets verified in W1 Spike S3 & S4
export const TIER_PRESETS: Record<"free" | "paid", Record<string, ModelLimit>> = {
  free: {
    // Verified via QuotaFailure:
    // - RPM: EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier = 100
    // - RPD: EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier = 1000
    // Note: batchEmbedContents with N items deducts N requests from both RPM and RPD buckets.
    "gemini-embedding-2": { rpm: 100, tpm: 30_000, rpd: 1_000 },
    "gemini-3.1-flash-lite": { rpm: 15, tpm: 250_000, rpd: 500 },
    "gemini-3.5-flash-lite": { rpm: 15, tpm: 250_000, rpd: 500 },
    "gemma-4-31b-it": { rpm: 30, tpm: 15_000, rpd: 14_400 },
    "gemma-4-26b-a4b-it": { rpm: 30, tpm: 15_000, rpd: 14_400 },
    "gemini-decision-1": { rpm: 200, tpm: 50_000, rpd: 10_000 },
  },
  paid: {
    "gemini-embedding-2": { rpm: 3_000, tpm: 1_000_000, rpd: 500_000 },
    "gemini-3.1-flash-lite": { rpm: 2_000, tpm: 4_000_000, rpd: 500_000 },
    "gemini-3.5-flash-lite": { rpm: 2_000, tpm: 4_000_000, rpd: 500_000 },
    "gemini-decision-1": { rpm: 2_000, tpm: 1_000_000, rpd: 500_000 },
  },
};

export const ConfigSchema = z.object({
  tier: z.enum(["free", "paid"]).default("paid"),
  dataDir: z
    .string()
    .default(join(homedir(), "Library/Application Support/bookmark-agent")),
  dbPath: z.string().optional(),
  embedding: z
    .object({
      provider: z.enum(["gemini", "local"]).default("gemini"),
      model: z.string().default("gemini-embedding-2"),
      dim: z.number().int().default(768),
      apiKeyRef: z.string().default("env:GEMINI_API_KEY|keychain:collections-mcp/google"),
    })
    .default({}),
  enrich: z
    .object({
      model: z.string().default("gemini-3.1-flash-lite"),
      overflowModels: z
        .array(z.string())
        .default(["gemma-4-31b-it", "gemma-4-26b-a4b-it", "gemini-3.5-flash-lite"]),
      promptVersion: z.string().default("v1"),
      apiKeyRef: z.string().default("env:GEMINI_API_KEY|keychain:collections-mcp/google"),
    })
    .default({}),
  decisions: z
    .object({
      model: z.string().default("gemini-decision-1"),
      rerank: z.boolean().default(true),
      classifyFallback: z.boolean().default(true),
      apiKeyRef: z.string().default("env:GEMINI_API_KEY|keychain:collections-mcp/google"),
    })
    .default({}),
  limits: z.record(z.string(), ModelLimitSchema).optional(),
  cache: z
    .object({
      dir: z.string().optional(),
      enabled: z.boolean().default(true),
    })
    .default({}),
  privacy: z
    .object({
      allowCloudForContent: z.boolean().default(true),
    })
    .default({}),
});

export type CollectionsConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(overrides: Partial<CollectionsConfig> = {}): CollectionsConfig {
  const configPath =
    process.env.COLLECTIONS_MCP_CONFIG ||
    join(homedir(), ".config/collections-mcp/config.json");

  let fileData: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      fileData = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      // Ignore malformed config file and fall back to defaults
    }
  }

  const envOverrides: Record<string, unknown> = {};
  if (process.env.COLLECTIONS_DB_PATH) {
    envOverrides.dbPath = process.env.COLLECTIONS_DB_PATH;
  }
  if (process.env.COLLECTIONS_DATA_DIR) {
    envOverrides.dataDir = process.env.COLLECTIONS_DATA_DIR;
  }

  const parsed = ConfigSchema.parse({
    ...fileData,
    ...envOverrides,
    ...overrides,
  });

  if (!parsed.dbPath) {
    parsed.dbPath = join(parsed.dataDir, "collections.db");
  }
  if (!parsed.cache.dir) {
    parsed.cache.dir =
      process.env.COLLECTIONS_CACHE_DIR ||
      (parsed.dbPath !== ":memory:"
        ? join( parsed.dbPath, "..", "llm-cache")
        : join(parsed.dataDir, "llm-cache"));
  }
  if (!parsed.limits) {
    parsed.limits = TIER_PRESETS[parsed.tier];
  }
  return parsed;
}

/**
 * SecretStore: resolves secret references in priority order:
 * 1. Environment variables (e.g. GEMINI_API_KEY, GOOGLE_API_KEY)
 * 2. macOS Keychain via `security find-generic-password -s <service> -w`
 */
export class SecretStore {
  static resolve(ref = "env:GEMINI_API_KEY|keychain:collections-mcp/google"): string | null {
    const parts = ref.split("|").map((s) => s.trim());
    for (const part of parts) {
      if (part.startsWith("env:")) {
        const envName = part.slice(4);
        const val = process.env[envName];
        if (val && val.trim()) return val.trim().replace(/^["']|["']$/g, "");
      } else if (part.startsWith("keychain:")) {
        const service = part.slice(9);
        const val = SecretStore.readFromMacKeychain(service);
        if (val) return val;
      }
    }
    return null;
  }

  static readFromMacKeychain(service: string): string | null {
    if (process.platform !== "darwin") return null;
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", service, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return out.trim() || null;
    } catch {
      return null;
    }
  }
}
