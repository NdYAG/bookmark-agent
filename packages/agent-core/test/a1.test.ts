import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  A1_CONVERSATION_SCENARIOS,
  A2uiGenerator,
  AppSessionStore,
  BookmarkAgent,
  CollectionsMcpBridge,
  convertToLlm,
  createScriptedLlmProvider,
  runA1ConversationEval,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const mcpServerEntry = join(repoRoot, "packages/collections-mcp/dist/server.js");
const datasetPath = join(repoRoot, "packages/eval/dataset/items.json");

describe("A1 · BookmarkAgent (pi-agent + pi-mcp + A2UI + Catalog + 20-Scenario Eval)", () => {
  let tempDir: string;
  let collectionsDbPath: string;
  let appDbPath: string;
  let mcpBridge: CollectionsMcpBridge;
  let sessionStore: AppSessionStore;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bookmark-agent-a1-"));
    collectionsDbPath = join(tempDir, "collections.db");
    appDbPath = join(tempDir, "app.db");

    mcpBridge = new CollectionsMcpBridge({
      serverScriptPath: mcpServerEntry,
      env: {
        COLLECTIONS_DB_PATH: collectionsDbPath,
        COLLECTIONS_DATA_DIR: tempDir,
        COLLECTIONS_SEED_PATH: datasetPath,
      },
    });
    await mcpBridge.connect();
    sessionStore = new AppSessionStore(appDbPath);
  });

  afterAll(async () => {
    await mcpBridge.close();
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("filters out all app_* tools before exposing MCP tools to the LLM", () => {
    const allTools = mcpBridge.getAllTools();
    const llmTools = mcpBridge.getLlmTools();

    expect(allTools.some((t) => t.name.startsWith("app_"))).toBe(true);
    expect(llmTools.some((t) => t.name.startsWith("app_"))).toBe(false);
    expect(llmTools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "search",
        "get_items",
        "read_item",
        "stats",
        "add",
        "update",
        "remove",
      ]),
    );
  });

  it("enforces beforeToolCall confirmation on write operations (add / update / remove)", async () => {
    mcpBridge.setBeforeToolCall(async ({ isWriteOperation }) => {
      if (isWriteOperation) {
        return { allow: false, reason: "User denied write operation in dialog" };
      }
      return { allow: true };
    });

    const blockedRemove = await mcpBridge.callLlmTool("remove", {
      id: "x:1000000000000000002",
    });
    expect(blockedRemove.ok).toBe(false);
    expect(blockedRemove.blockedByConfirmation).toBe(true);
    expect(blockedRemove.data.code).toBe("USER_DENIED_TOOL_CALL");

    const stillThere = await mcpBridge.lookupItemsByIds(["x:1000000000000000002"]);
    expect(stillThere.length).toBe(1);

    mcpBridge.setBeforeToolCall(async () => ({ allow: true }));
    const allowedUpdate = await mcpBridge.callLlmTool("update", {
      id: "x:1000000000000000002",
      note: "A1 confirmed note update",
    });
    expect(allowedUpdate.ok).toBe(true);
    expect(allowedUpdate.data.item.note).toBe("A1 confirmed note update");

    mcpBridge.setBeforeToolCall(undefined);
  });

  it("expands CollectionCard(id) and ItemGrid([ids]) macros on server via get_items", async () => {
    const gen = new A2uiGenerator((ids) => mcpBridge.lookupItemsByIds(ids));
    const stream = gen.openStream();

    stream.feed(
      `这是为你找到的 WebGPU 渲染收藏：\n\`\`\`a2ui\n` +
        JSON.stringify({
          surfaceId: "main",
          components: [
            {
              component: "CollectionCard",
              props: {
                id: "x:1000000000000000008",
                highlight: "120fps WebGPU Canvas",
              },
            },
          ],
        }) +
        `\n\`\`\``,
    );

    const out = await stream.finishTurn();
    expect(out.compileSuccess).toBe(true);
    expect(out.compileAttempts).toBe(1);
    expect(out.surfaces.length).toBe(1);

    const cardNode = out.surfaces[0].components[0];
    expect(cardNode.component).toBe("CollectionCard");
    expect(cardNode.props.id).toBe("x:1000000000000000008");
    expect(cardNode.props.item).toBeDefined();
    expect(cardNode.props.item.author).toContain("@gpu_craft");
    expect(cardNode.props.item.url).toContain("1000000000000000008");
  });

  it("retries once via finishTurn on A2UI compile failure and degrades to plain text if retry also fails", async () => {
    const gen = new A2uiGenerator((ids) => mcpBridge.lookupItemsByIds(ids));

    const stream1 = gen.openStream();
    stream1.feed(
      `回答正文分析。\n\`\`\`a2ui\n{ "surfaceId": "main", "components": [ INVALID_JSON }\n\`\`\``,
    );
    const out1 = await stream1.finishTurn(async (repairPrompt) => {
      expect(repairPrompt).toContain("编译失败");
      return (
        `回答正文分析。\n\`\`\`a2ui\n` +
        JSON.stringify({
          surfaceId: "main",
          components: [
            {
              component: "CollectionCard",
              props: { id: "x:1000000000000000008" },
            },
          ],
        }) +
        `\n\`\`\``
      );
    });
    expect(out1.compileAttempts).toBe(2);
    expect(out1.compileSuccess).toBe(true);
    expect(out1.degradedToPlainText).toBe(false);
    expect(out1.surfaces.length).toBe(1);

    const stream2 = gen.openStream();
    stream2.feed(
      `即使 UI 失败也保留的纯文本分析结论。\n\`\`\`a2ui\n{ "broken": true }\n\`\`\``,
    );
    const out2 = await stream2.finishTurn(async () => {
      return `即使 UI 失败也保留的纯文本分析结论。\n\`\`\`a2ui\n{ "stillBroken": true }\n\`\`\``;
    });
    expect(out2.compileAttempts).toBe(2);
    expect(out2.compileSuccess).toBe(false);
    expect(out2.degradedToPlainText).toBe(true);
    expect(out2.surfaces.length).toBe(0);
    expect(out2.plainText).toContain("即使 UI 失败也保留的纯文本分析结论");
  });

  it("converts attached_items & ui_action and decompiles only the active surface to Express while summarizing old surfaces", () => {
    const history = [
      {
        role: "user" as const,
        type: "attached_items" as const,
        items: [
          {
            id: "x:1000000000000000008",
            author: "@gpu_craft",
            excerpt: "WebGPU 5,000 UI frames",
          },
        ],
        prompt: "先看第一条",
      },
      {
        role: "assistant" as const,
        type: "assistant_response" as const,
        text: "第一轮回答",
        surfaces: [
          {
            surfaceId: "s1",
            components: [
              {
                component: "CollectionCard" as const,
                props: { id: "x:1000000000000000008", highlight: "Old card" },
              },
            ],
          },
        ],
      },
      {
        role: "user" as const,
        type: "ui_action" as const,
        surfaceId: "s1",
        action: "explore_related",
        itemId: "x:1000000000000000008",
        context: { untrustedNote: "click" },
      },
      {
        role: "assistant" as const,
        type: "assistant_response" as const,
        text: "第二轮回答",
        surfaces: [
          {
            surfaceId: "s2",
            components: [
              {
                component: "ItemGrid" as const,
                props: {
                  title: "Active Grid",
                  ids: ["x:1000000000000000008", "x:1000000000000000009"],
                },
              },
            ],
          },
        ],
      },
    ];

    const llmMsgs = convertToLlm(history);
    expect(llmMsgs.length).toBe(4);
    expect(llmMsgs[0].content).toContain("x:1000000000000000008");
    expect(llmMsgs[1].content).toContain("[历史 A2UI Surface #s1:");
    expect(llmMsgs[1].content).not.toContain('surface("s1")');
    expect(llmMsgs[2].content).toContain("Untrusted action.context:");
    expect(llmMsgs[3].content).toContain('surface("s2") {');
    expect(llmMsgs[3].content).toContain('ItemGrid(title="Active Grid"');
  });

  it("persists and replays conversation sessions (messages + A2UI surfaces) in app.db", async () => {
    const llm = createScriptedLlmProvider(A1_CONVERSATION_SCENARIOS[0].scriptedTurns);
    const agent = new BookmarkAgent({
      mcpBridge,
      llm,
      sessionStore,
    });

    const sessionId = "replay-test-session";
    await agent.runTurn(sessionId, A1_CONVERSATION_SCENARIOS[0].userMessage);

    const replayed = sessionStore.getSessionMessages(sessionId);
    expect(replayed.length).toBe(2);
    expect(replayed[0].role).toBe("user");
    expect(replayed[1].role).toBe("assistant");
    if (replayed[1].role === "assistant") {
      expect(replayed[1].surfaces?.length).toBe(1);
      expect(replayed[1].surfaces?.[0].components[0].props.item.id).toBe(
        "x:1000000000000000008",
      );
    }

    const searchHits = sessionStore.searchMessages("WebGPU");
    expect(searchHits.length).toBeGreaterThan(0);
    expect(searchHits[0].sessionId).toBe(sessionId);
  });

  it("passes the 20-scenario A1 Conversation Evaluation Suite (compile rate >= 95%, 0 UI overuse on negative examples, 100% real cited IDs)", async () => {
    const summary = await runA1ConversationEval({
      createAgentForScenario: async (scenario) => {
        const llm = createScriptedLlmProvider(scenario.scriptedTurns);
        mcpBridge.setBeforeToolCall(async ({ isWriteOperation }) => {
          if (isWriteOperation) {
            return { allow: false, reason: "Confirmation required" };
          }
          return { allow: true };
        });

        const agent = new BookmarkAgent({
          mcpBridge,
          llm,
          sessionStore,
        });

        return {
          agent,
          verifyIdsExist: async (ids: string[]) => {
            const found = await mcpBridge.lookupItemsByIds(ids);
            const foundSet = new Set(found.map((f) => f.id));
            return ids.filter((id) => !foundSet.has(id));
          },
        };
      },
    });

    expect(summary.totalScenarios).toBe(20);
    expect(summary.a2uiCompilePassRate).toBeGreaterThanOrEqual(0.95);
    expect(summary.negativeNoUiOveruseRate).toBe(1.0);
    expect(summary.citedIdsExistRate).toBe(1.0);
    expect(summary.toolCallAccuracyRate).toBe(1.0);
    expect(summary.averageJudgeScore).toBeGreaterThanOrEqual(4.8);
  });
});
