import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectionsDB } from "../src/db/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const datasetPath = join(repoRoot, "packages/eval/dataset/items.json");
const serverEntryPath = join(here, "../dist/server.js");

describe("M0 · collections-mcp Data Layer & MCP Server", () => {
  let tempDir: string;
  let dbPath: string;
  let db: CollectionsDB;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collections-mcp-m0-"));
    dbPath = join(tempDir, "collections.db");
    db = new CollectionsDB(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("imports 60 synthetic bookmarks + embeddings from dataset and computes accurate stats", () => {
    const res = db.importFixturesFromFile(datasetPath);
    expect(res.total).toBe(60);
    expect(res.inserted).toBe(60);
    expect(res.updated).toBe(0);
    expect(res.tombstoned).toBe(0);
    expect(res.embeddingsLoaded).toBe(60);

    const st = db.stats();
    expect(st.total_active_items).toBe(60);
    expect(st.total_deleted_tombstones).toBe(0);
    expect(st.total_embeddings).toBe(60);
  });

  it("supports FTS5 trigram search (>= 3 chars) and LIKE fallback (< 3 chars) in Chinese and English", () => {
    db.importFixturesFromFile(datasetPath);

    // 1. English FTS5 trigram search
    const rustHits = db.search({ query: "Rust GPUI" });
    expect(rustHits.length).toBeGreaterThan(0);
    expect(rustHits.some((x) => x.id === "x:1000000000000000015")).toBe(true);

    // 2. Chinese FTS5 trigram search
    const growthHits = db.search({ query: "克服拖延 执行力" });
    expect(growthHits.length).toBeGreaterThan(0);
    expect(growthHits[0].id).toBe("x:1000000000000000028");

    // 3. Short Chinese query (< 3 chars: "插件", "设计") -> automatic LIKE fallback
    const pluginHits = db.search({ query: "插件" });
    expect(pluginHits.length).toBeGreaterThan(0);
    expect(pluginHits.some((x) => x.id === "x:1000000000000000031")).toBe(true);

    const designHits = db.search({ query: "设计" });
    expect(designHits.length).toBeGreaterThan(5);
  });

  it("prevents deleted items from resurrecting on re-import (soft-delete tombstones)", () => {
    db.importFixturesFromFile(datasetPath);

    // Delete item x:1000000000000000002 (Offline Evals post)
    const rmRes = db.removeItem("x:1000000000000000002");
    expect(rmRes.ok).toBe(true);

    // Confirm it's gone from active items & search
    expect(db.getItems(["x:1000000000000000002"]).length).toBe(0);
    expect(
      db.search({ query: "Offline Evals" }).some((x) => x.id === "x:1000000000000000002"),
    ).toBe(false);
    expect(db.stats().total_active_items).toBe(59);
    expect(db.stats().total_deleted_tombstones).toBe(1);

    // Re-import the entire 60-bookmark dataset
    const reimport = db.importFixturesFromFile(datasetPath);
    expect(reimport.total).toBe(60);
    expect(reimport.tombstoned).toBe(1);
    expect(reimport.updated).toBe(59);
    expect(reimport.inserted).toBe(0);

    // Confirm the deleted item did NOT resurrect
    expect(db.stats().total_active_items).toBe(59);
    expect(db.getItems(["x:1000000000000000002"]).length).toBe(0);
  });

  it("preserves user-edited fields (user_overrides) across re-imports", () => {
    db.importFixturesFromFile(datasetPath);

    const targetId = "x:1000000000000000008";
    const upd = db.updateItem(targetId, {
      title: "我自定义的 WebGPU 120fps 渲染引擎标题",
      note: "核心参考：WebGPU Canvas 实时交互",
      category: "webgpu-graphics",
    });
    expect(upd.ok).toBe(true);

    // Re-import the entire 60-bookmark dataset
    db.importFixturesFromFile(datasetPath);

    // Verify user-edited title, note, and category were NOT overwritten
    const [after] = db.getItems([targetId]);
    expect(after.title).toBe("我自定义的 WebGPU 120fps 渲染引擎标题");
    expect(after.note).toBe("核心参考：WebGPU Canvas 实时交互");
    expect(after.category).toBe("webgpu-graphics");
  });

  it("works end-to-end over MCP stdio protocol (Agent client <-> collections-mcp server)", async () => {
    db.close();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntryPath],
      env: {
        ...process.env,
        COLLECTIONS_DB_PATH: dbPath,
        COLLECTIONS_SEED_PATH: datasetPath,
      },
    });

    const client = new Client(
      { name: "m0-verifier", version: "0.1.0" },
      { capabilities: {} },
    );

    await client.connect(transport);

    try {
      // 1. Verify registered tools (LLM face + App face)
      const toolsList = await client.listTools();
      const toolNames = toolsList.tools.map((t) => t.name);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "search",
          "get_items",
          "stats",
          "add",
          "update",
          "remove",
          "app_list_items",
          "app_import_fixtures",
        ]),
      );

      // 2. Seeded X (40) + XHS (20) = 60 items on first start: verify via `stats` tool
      const statsRes = await client.callTool({ name: "stats", arguments: {} });
      const statsData = JSON.parse((statsRes.content as Array<{ text: string }>)[0].text);
      expect(statsData.total_active_items).toBe(60);
      expect(statsData.by_source).toEqual(
        expect.arrayContaining([
          { source: "x", count: 40 },
          { source: "xhs", count: 20 },
        ]),
      );

      // 3. Query in English via `search` tool
      const searchRes = await client.callTool({
        name: "search",
        arguments: { query: "WebGPU 120fps", limit: 5 },
      });
      const searchData = JSON.parse((searchRes.content as Array<{ text: string }>)[0].text);
      expect(searchData.count).toBeGreaterThan(0);
      expect(searchData.items[0].id).toBe("x:1000000000000000008");

      // 4. Test `app_list_items` pagination & filtering
      const listRes = await client.callTool({
        name: "app_list_items",
        arguments: { page: 1, pageSize: 10, filter: { mediaType: "article" } },
      });
      const listData = JSON.parse((listRes.content as Array<{ text: string }>)[0].text);
      expect(listData.total).toBe(5);
      expect(listData.items.length).toBe(5);
    } finally {
      await client.close();
      db = new CollectionsDB(dbPath);
    }
  });
});
