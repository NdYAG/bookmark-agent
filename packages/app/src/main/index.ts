import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  safeStorage,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { CoverCache } from "./cover-cache.js";
import { checkAgentBrowserEnv } from "./env-check.js";
import { AppSecretStore } from "./secrets.js";
import { AppSettingsStore } from "./settings.js";
import { resolveDefaultCollectionsDbPath } from "../worker/runtime.js";
import type { AppSettings, SafeSettingsPayload } from "../shared/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const appPackageRoot = join(here, "../..");
const repoRoot = join(appPackageRoot, "../..");

let mainWindow: BrowserWindow | null = null;
let worker: UtilityProcess | null = null;
let workerReady: Promise<void> = Promise.resolve();
const pendingCalls = new Map<
  string,
  { resolve: (val: any) => void; reject: (err: Error) => void }
>();

let secretStore: AppSecretStore;
let settingsStore: AppSettingsStore;
let coverCache: CoverCache;

function getDataDir(): string {
  return join(app.getPath("appData"), "bookmark-agent");
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function callWorker<T = any>(method: string, ...args: any[]): Promise<T> {
  return new Promise(async (resolve, reject) => {
    try {
      await workerReady;
      if (!worker) {
        reject(new Error("Agent utilityProcess is not running"));
        return;
      }
      const id = randomUUID();
      pendingCalls.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    } catch (err: any) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function spawnWorker(): void {
  const dataDir = getDataDir();
  const settings = settingsStore.load();
  const { key: apiKey } = secretStore.resolveGeminiApiKey();
  const collectionsDbPath =
    settings.collectionsDbPath ||
    process.env.COLLECTIONS_DB_PATH ||
    resolveDefaultCollectionsDbPath(repoRoot, dataDir);
  const appDbPath = join(dataDir, "app.db");
  const mcpServerScriptPath = join(repoRoot, "packages/collections-mcp/dist/server.js");
  const workerScriptPath = join(appPackageRoot, "dist/worker/agent-worker.js");

  worker = utilityProcess.fork(workerScriptPath, [], {
    serviceName: "bookmark-agent-worker",
    env: {
      ...(process.env as Record<string, string>),
      MCP_SERVER_SCRIPT_PATH: mcpServerScriptPath,
      COLLECTIONS_DB_PATH: collectionsDbPath,
      APP_DB_PATH: appDbPath,
      BOOKMARK_AGENT_CHAT_MODEL: settings.chatModel,
      ...(apiKey ? { GEMINI_API_KEY: apiKey } : {}),
    },
  });

  workerReady = new Promise<void>((resolve, reject) => {
    let settled = false;
    worker?.on("message", (msg: any) => {
      if (msg?.type === "ready" && !settled) {
        settled = true;
        resolve();
        return;
      }
      if (msg?.type === "fatal" && !settled) {
        settled = true;
        reject(new Error(msg.error || "Worker failed to start"));
        return;
      }
      if (msg?.type === "event" && msg.channel) {
        broadcast(msg.channel, msg.payload);
        return;
      }
      if (msg?.type === "response" && msg.id) {
        const entry = pendingCalls.get(msg.id);
        if (!entry) return;
        pendingCalls.delete(msg.id);
        if (msg.ok) entry.resolve(msg.data);
        else entry.reject(new Error(msg.error || "Worker call failed"));
      }
    });

    worker?.on("exit", (code) => {
      for (const [, p] of pendingCalls) {
        p.reject(new Error(`Agent worker exited (code=${code})`));
      }
      pendingCalls.clear();
      worker = null;
    });
  });
}

async function restartWorker(): Promise<void> {
  if (worker) {
    try {
      await callWorker("shutdown");
    } catch {
      worker?.kill();
    }
    worker = null;
  }
  spawnWorker();
  await workerReady;
}

function getSafeSettings(): SafeSettingsPayload {
  return {
    settings: settingsStore.load(),
    apiKeyStatus: secretStore.getSafeStatus(),
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle("items:list", (_ev, params) => callWorker("listItems", params));
  ipcMain.handle("items:update", (_ev, id, patch) => callWorker("updateItem", id, patch));
  ipcMain.handle("items:remove", (_ev, id) => callWorker("removeItem", id));
  ipcMain.handle("items:related", (_ev, id, k, mode) => callWorker("getRelated", id, k, mode));
  ipcMain.handle("items:dismissRelated", (_ev, targetId, candidateId) =>
    callWorker("dismissRelated", targetId, candidateId),
  );
  ipcMain.handle("items:resolveCover", async (_ev, remoteUrl: string) => {
    if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) return null;
    return `bookmark-cover://fetch?url=${encodeURIComponent(remoteUrl)}`;
  });

  ipcMain.handle("meta:get", () => callWorker("getMeta"));
  ipcMain.handle("meta:proposeTaxonomy", (_ev, useDecisionsFallback) =>
    callWorker("proposeTaxonomy", useDecisionsFallback),
  );
  ipcMain.handle("meta:editCategories", (_ev, categories) =>
    callWorker("editCategories", categories),
  );
  ipcMain.handle("meta:pending", (_ev, limit) => callWorker("listPending", limit));
  ipcMain.handle("meta:confirmCategory", (_ev, itemId, categoryId) =>
    callWorker("confirmCategory", itemId, categoryId),
  );

  ipcMain.handle("sources:loginCheck", (_ev, sourceId) => callWorker("loginCheck", sourceId));
  ipcMain.handle("sources:loginHandoff", (_ev, sourceId) => callWorker("loginHandoff", sourceId));
  ipcMain.handle("sources:loginForget", (_ev, sourceId) => callWorker("loginForget", sourceId));
  ipcMain.handle("sources:sync", (_ev, sourceId, maxItems) =>
    callWorker("syncSource", sourceId, maxItems),
  );

  ipcMain.handle("chat:listSessions", () => callWorker("listSessions"));
  ipcMain.handle("chat:createSession", (_ev, title) => callWorker("createSession", title));
  ipcMain.handle("chat:getMessages", (_ev, sessionId) => callWorker("getMessages", sessionId));
  ipcMain.handle("chat:searchMessages", (_ev, query, limit) =>
    callWorker("searchMessages", query, limit),
  );
  ipcMain.handle("chat:sendMessage", (_ev, req) => callWorker("sendMessage", req));
  ipcMain.handle("chat:setWriteMode", (_ev, allowWrites) =>
    callWorker("setWriteMode", allowWrites),
  );

  ipcMain.handle("settings:get", () => getSafeSettings());
  ipcMain.handle("settings:save", async (_ev, patch: Partial<AppSettings>) => {
    const prev = settingsStore.load();
    const next = settingsStore.save(patch);
    const needsRestart =
      prev.chatModel !== next.chatModel ||
      prev.tier !== next.tier ||
      prev.allowCloudForContent !== next.allowCloudForContent ||
      prev.collectionsDbPath !== next.collectionsDbPath;
    if (needsRestart) {
      await restartWorker();
    }
    return getSafeSettings();
  });
  ipcMain.handle("settings:setApiKey", async (_ev, apiKey: string) => {
    secretStore.setGeminiApiKey(apiKey);
    await restartWorker();
    return getSafeSettings();
  });
  ipcMain.handle("settings:checkEnv", () => checkAgentBrowserEnv());

  // External links are ONLY opened via user gesture, validated to http(s)
  ipcMain.handle("shell:openExternal", async (_ev, rawUrl: string) => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false };
      }
      await shell.openExternal(parsed.toString());
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: "Bookmark Agent",
    backgroundColor: "#f6f8fb",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(appPackageRoot, "dist/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(appPackageRoot, "dist/renderer/index.html"));
  }
}

app.whenReady().then(() => {
  const dataDir = getDataDir();
  secretStore = new AppSecretStore(dataDir, safeStorage);
  settingsStore = new AppSettingsStore({ dataDir });
  coverCache = new CoverCache(join(dataDir, "covers"));

  protocol.handle("bookmark-cover", async (request) => {
    try {
      const u = new URL(request.url);
      const remoteUrl = u.searchParams.get("url");
      if (!remoteUrl) return new Response(null, { status: 400 });
      const cached = await coverCache.ensureCached(remoteUrl);
      if (!cached) return new Response(null, { status: 404 });
      const bytes = readFileSync(cached.path);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": cached.mime,
          "Cache-Control": "public, max-age=604800",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  registerIpcHandlers();
  spawnWorker();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  if (worker) {
    worker.kill();
    worker = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
