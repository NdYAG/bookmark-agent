import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  A1_CONVERSATION_SCENARIOS,
  createScriptedLlmProvider,
} from "@bookmark-agent/agent-core";
import { CoverCache } from "../src/main/cover-cache.js";
import { checkAgentBrowserEnv, compareSemver } from "../src/main/env-check.js";
import { AppSecretStore, maskApiKey } from "../src/main/secrets.js";
import { AppSettingsStore } from "../src/main/settings.js";
import { AgentRuntime } from "../src/worker/runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const mcpServerEntry = join(repoRoot, "packages/collections-mcp/dist/server.js");
const datasetPath = join(repoRoot, "packages/eval/dataset/items.json");

describe("E · Electron App Core Services & AgentRuntime", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bookmark-agent-e-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("encrypts API keys via safeStorage and never exposes plaintext in status", () => {
    const mockSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(`ENC:${plain}`, "utf8"),
      decryptString: (buf: Buffer) => buf.toString("utf8").replace(/^ENC:/, ""),
    };
    const store = new AppSecretStore(join(tempDir, "sec"), mockSafeStorage);
    store.setGeminiApiKey("AIzaSyTestSecretKey987654321");

    const resolved = store.resolveGeminiApiKey();
    expect(resolved.key).toBe("AIzaSyTestSecretKey987654321");
    expect(resolved.source).toBe("safeStorage");

    const safeStatus = store.getSafeStatus();
    expect(safeStatus.hasKey).toBe(true);
    expect(safeStatus.masked).toBe("AIza••••4321");
    expect(safeStatus.masked).not.toContain("TestSecretKey");
    expect(maskApiKey("short")).toBe("••••••••");
  });

  it("synchronizes non-secret settings to collections-mcp config.json", () => {
    const mcpCfgPath = join(tempDir, "mcp-config.json");
    const store = new AppSettingsStore({
      dataDir: join(tempDir, "settings"),
      mcpConfigPath: mcpCfgPath,
    });
    const initial = store.load();
    expect(initial.developerView).toBe(false);

    const saved = store.save({
      tier: "free",
      allowCloudForContent: false,
      chatModel: "gemini-3.6-flash",
      onboardingCompleted: true,
      developerView: true,
    });
    expect(saved.tier).toBe("free");
    expect(saved.allowCloudForContent).toBe(false);
    expect(saved.developerView).toBe(true);

    const mirrored = JSON.parse(readFileSync(mcpCfgPath, "utf8"));
    expect(mirrored.tier).toBe("free");
    expect(mirrored.privacy.allowCloudForContent).toBe(false);
  });

  it("detects agent-browser version and flags outdated/missing installs", () => {
    expect(compareSemver("0.43.0", "0.41.0")).toBeGreaterThan(0);
    expect(compareSemver("0.40.9", "0.41.0")).toBeLessThan(0);

    const okRes = checkAgentBrowserEnv(((cmd: string) => {
      if (cmd === "which") return "/opt/homebrew/bin/agent-browser\n";
      return "agent-browser 0.43.0\n";
    }) as any);
    expect(okRes.ok).toBe(true);
    expect(okRes.version).toBe("0.43.0");

    const oldRes = checkAgentBrowserEnv(((cmd: string) => {
      if (cmd === "which") return "/usr/local/bin/agent-browser\n";
      return "agent-browser 0.39.0\n";
    }) as any);
    expect(oldRes.ok).toBe(false);
    expect(oldRes.installed).toBe(true);
  });

  it("caches remote cover images locally and avoids redundant fetches", async () => {
    let fetchCount = 0;
    const fakeBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const cache = new CoverCache(join(tempDir, "covers"), (async () => {
      fetchCount++;
      return new Response(fakeBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as any);

    const url = "https://sns-webpic-qc.xhscdn.com/test-cover-1.png";
    const first = await cache.ensureCached(url);
    const second = await cache.ensureCached(url);
    expect(first).not.toBeNull();
    expect(second?.path).toBe(first?.path);
    expect(fetchCount).toBe(1);
  });

  it("runs AgentRuntime with multi-source X + XHS items, related feedback dismissal, and FTS5 history search", async () => {
    const streamEvents: string[] = [];
    const runtime = new AgentRuntime({
      mcpServerScriptPath: mcpServerEntry,
      collectionsDbPath: join(tempDir, "runtime-collections.db"),
      appDbPath: join(tempDir, "runtime-app.db"),
      seedFixturePath: datasetPath,
      llm: createScriptedLlmProvider(A1_CONVERSATION_SCENARIOS[0].scriptedTurns),
      onChatStream: (_sid, ev) => streamEvents.push(ev.type),
    });

    await runtime.start();
    try {
      // 1. Multi-source listing (40 X + 20 XHS = 60)
      const all = await runtime.listItems({ page: 1, pageSize: 20 });
      expect(all.total).toBe(60);

      const xhsOnly = await runtime.listItems({ page: 1, pageSize: 10, source: "xhs" });
      expect(xhsOnly.total).toBe(20);

      // 2. Cross-platform related + "不相关" feedback persistence
      const rel1 = await runtime.getRelated(
        "xhs:600000000000000000000009",
        6,
        "feature-fusion",
      );
      expect(rel1.target?.id).toBe("xhs:600000000000000000000009");
      expect(rel1.related.length).toBeGreaterThan(1);

      const dismissedCandidate = rel1.related[0].id;
      runtime.dismissRelated(rel1.targetId, dismissedCandidate);

      const rel2 = await runtime.getRelated(
        "xhs:600000000000000000000009",
        6,
        "feature-fusion",
      );
      expect(rel2.related.some((r) => r.id === dismissedCandidate)).toBe(false);

      // 3. Streaming A2UI chat + FTS5 message search
      const session = runtime.createSession("测试会话");
      const sendRes = await runtime.sendMessage({
        sessionId: session.id,
        text: "深挖 x:1000000000000000008 WebGPU 渲染架构",
      });
      expect(sendRes.ok).toBe(true);
      expect(streamEvents).toContain("surface_ready");
      expect(streamEvents).toContain("turn_complete");

      const hits = runtime.searchMessages("WebGPU");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].sessionId).toBe(session.id);
    } finally {
      await runtime.close();
    }
  }, 30000);
});
