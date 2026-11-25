import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppSettings } from "../shared/types.js";

const DEFAULT_APP_SETTINGS: AppSettings = {
  chatProvider: "gemini",
  chatModel: process.env.BOOKMARK_AGENT_CHAT_MODEL || "gemini-3.1-flash-lite",
  tier: "paid",
  allowCloudForContent: true,
  onboardingCompleted: false,
  developerView: false,
};

/**
 * Unified settings manager (design.md §7.2):
 * - Persists App settings in `<dataDir>/app-settings.json`
 * - Synchronizes non-secret MCP config (`tier`, `privacy.allowCloudForContent`) to `~/.config/collections-mcp/config.json`
 *   so `collections-mcp` stays usable both inside Electron and standalone (e.g., Claude Code).
 */
export class AppSettingsStore {
  private readonly appSettingsPath: string;
  private readonly mcpConfigPath: string;

  constructor(opts: { dataDir: string; mcpConfigPath?: string }) {
    this.appSettingsPath = join(opts.dataDir, "app-settings.json");
    this.mcpConfigPath =
      opts.mcpConfigPath ||
      process.env.COLLECTIONS_MCP_CONFIG ||
      join(homedir(), ".config/collections-mcp/config.json");
  }

  load(): AppSettings {
    let saved: Partial<AppSettings> = {};
    if (existsSync(this.appSettingsPath)) {
      try {
        saved = JSON.parse(readFileSync(this.appSettingsPath, "utf8"));
      } catch {
        saved = {};
      }
    }

    let mcpFile: Record<string, any> = {};
    if (existsSync(this.mcpConfigPath)) {
      try {
        mcpFile = JSON.parse(readFileSync(this.mcpConfigPath, "utf8"));
      } catch {
        mcpFile = {};
      }
    }

    return {
      ...DEFAULT_APP_SETTINGS,
      ...(mcpFile.tier === "free" || mcpFile.tier === "paid" ? { tier: mcpFile.tier } : {}),
      ...(typeof mcpFile.privacy?.allowCloudForContent === "boolean"
        ? { allowCloudForContent: mcpFile.privacy.allowCloudForContent }
        : {}),
      ...saved,
    };
  }

  save(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = {
      ...this.load(),
      ...patch,
    };

    mkdirSync(dirname(this.appSettingsPath), { recursive: true });
    writeFileSync(this.appSettingsPath, JSON.stringify(next, null, 2));

    // Mirror non-secret MCP settings into collections-mcp config.json
    let existingMcp: Record<string, any> = {};
    if (existsSync(this.mcpConfigPath)) {
      try {
        existingMcp = JSON.parse(readFileSync(this.mcpConfigPath, "utf8"));
      } catch {
        existingMcp = {};
      }
    }
    const nextMcp = {
      ...existingMcp,
      tier: next.tier,
      privacy: {
        ...(existingMcp.privacy || {}),
        allowCloudForContent: next.allowCloudForContent,
      },
    };
    mkdirSync(dirname(this.mcpConfigPath), { recursive: true });
    writeFileSync(this.mcpConfigPath, JSON.stringify(nextMcp, null, 2));

    return next;
  }
}
