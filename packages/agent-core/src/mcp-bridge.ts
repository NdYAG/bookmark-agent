import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExpandedBookmarkItem } from "@bookmark-agent/catalog";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface BeforeToolCallDecision {
  allow: boolean;
  reason?: string;
}

export type BeforeToolCallHook = (call: {
  toolName: string;
  args: Record<string, unknown>;
  isWriteOperation: boolean;
}) => Promise<BeforeToolCallDecision> | BeforeToolCallDecision;

export const WRITE_TOOL_NAMES = new Set(["add", "update", "remove"]);

export interface CollectionsMcpBridgeOptions {
  serverScriptPath?: string;
  env?: Record<string, string>;
  client?: Client;
  beforeToolCall?: BeforeToolCallHook;
}

/**
 * PiMcpBridge:
 * Connects to `collections-mcp` (via stdio or in-process transport),
 * discovers tools, filters out `app_*` tools before exposing them to the LLM,
 * and enforces confirmation for write tools (`add`, `update`, `remove`) via `beforeToolCall`.
 */
export class CollectionsMcpBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private allTools: McpToolDefinition[] = [];
  private beforeToolCallHook?: BeforeToolCallHook;

  constructor(private readonly opts: CollectionsMcpBridgeOptions = {}) {
    this.beforeToolCallHook = opts.beforeToolCall;
    if (opts.client) {
      this.client = opts.client;
    }
  }

  setBeforeToolCall(hook?: BeforeToolCallHook) {
    this.beforeToolCallHook = hook;
  }

  async connect(): Promise<void> {
    if (!this.client) {
      if (!this.opts.serverScriptPath) {
        throw new Error("CollectionsMcpBridge requires either `client` or `serverScriptPath`");
      }
      this.transport = new StdioClientTransport({
        command: process.execPath,
        args: [this.opts.serverScriptPath],
        env: {
          ...(process.env as Record<string, string>),
          ...(this.opts.env || {}),
        },
      });
      this.client = new Client(
        { name: "bookmark-agent-core", version: "0.1.0" },
        { capabilities: {} },
      );
      await this.client.connect(this.transport);
    }

    const listRes = await this.client.listTools();
    this.allTools = (listRes.tools || []).map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: (t.inputSchema as Record<string, any>) || { type: "object", properties: {} },
    }));
  }

  async close(): Promise<void> {
    if (this.client && this.transport) {
      await this.client.close();
    }
  }

  /**
   * Returns ONLY the LLM-facing tools (filters out all `app_*` tools).
   */
  getLlmTools(): McpToolDefinition[] {
    return this.allTools.filter((t) => !t.name.startsWith("app_"));
  }

  /**
   * Returns all tools including `app_*` (for App UI / dev-web usage).
   */
  getAllTools(): McpToolDefinition[] {
    return [...this.allTools];
  }

  /**
   * Calls an LLM-facing tool with `beforeToolCall` write-operation confirmation guard.
   */
  async callLlmTool(
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<{
    ok: boolean;
    blockedByConfirmation?: boolean;
    data: any;
    rawText: string;
    elapsedMs: number;
  }> {
    if (toolName.startsWith("app_")) {
      return {
        ok: false,
        data: { error: `Tool '${toolName}' is an internal App UI tool and cannot be called by the LLM.` },
        rawText: JSON.stringify({
          error: `Tool '${toolName}' is an internal App UI tool and cannot be called by the LLM.`,
        }),
        elapsedMs: 0,
      };
    }

    const isWrite = WRITE_TOOL_NAMES.has(toolName);
    if (isWrite) {
      if (!this.beforeToolCallHook) {
        return {
          ok: false,
          blockedByConfirmation: true,
          data: {
            code: "CONFIRMATION_REQUIRED",
            toolName,
            args,
            message: `Write operation '${toolName}' requires explicit user confirmation via beforeToolCall.`,
          },
          rawText: JSON.stringify({
            code: "CONFIRMATION_REQUIRED",
            toolName,
            args,
            message: `Write operation '${toolName}' requires explicit user confirmation.`,
          }),
          elapsedMs: 0,
        };
      }
      const decision = await this.beforeToolCallHook({
        toolName,
        args,
        isWriteOperation: true,
      });
      if (!decision.allow) {
        return {
          ok: false,
          blockedByConfirmation: true,
          data: {
            code: "USER_DENIED_TOOL_CALL",
            toolName,
            args,
            reason: decision.reason || "User declined the write operation.",
          },
          rawText: JSON.stringify({
            code: "USER_DENIED_TOOL_CALL",
            toolName,
            args,
            reason: decision.reason || "User declined the write operation.",
          }),
          elapsedMs: 0,
        };
      }
    } else if (this.beforeToolCallHook) {
      const decision = await this.beforeToolCallHook({
        toolName,
        args,
        isWriteOperation: false,
      });
      if (!decision.allow) {
        return {
          ok: false,
          blockedByConfirmation: true,
          data: {
            code: "TOOL_CALL_BLOCKED",
            toolName,
            reason: decision.reason || "Blocked by beforeToolCall hook",
          },
          rawText: JSON.stringify({
            code: "TOOL_CALL_BLOCKED",
            toolName,
            reason: decision.reason || "Blocked by beforeToolCall hook",
          }),
          elapsedMs: 0,
        };
      }
    }

    return this.invokeRawTool(toolName, args);
  }

  /**
   * Calls an App-facing tool directly (e.g., `app_list_items`), bypassing the LLM.
   */
  async callAppTool(
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<{
    ok: boolean;
    data: any;
    rawText: string;
    elapsedMs: number;
  }> {
    return this.invokeRawTool(toolName, args);
  }

  /**
   * Helper for server-side macro expansion (`CollectionCard(id)` -> `get_items`).
   */
  async lookupItemsByIds(ids: string[]): Promise<ExpandedBookmarkItem[]> {
    if (!ids.length) return [];
    const res = await this.invokeRawTool("get_items", { ids: ids.slice(0, 50) });
    if (!res.ok || !res.data || !Array.isArray(res.data.items)) {
      return [];
    }
    return res.data.items as ExpandedBookmarkItem[];
  }

  private async invokeRawTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    data: any;
    rawText: string;
    elapsedMs: number;
  }> {
    if (!this.client) {
      throw new Error("CollectionsMcpBridge is not connected");
    }
    const t0 = Date.now();
    const res = await this.client.callTool({
      name: toolName,
      arguments: args,
    });
    const elapsedMs = Date.now() - t0;
    const rawText = ((res.content as Array<{ text?: string }>) || [])
      .map((c) => c.text || "")
      .join("\n");
    let data: any = rawText;
    try {
      data = JSON.parse(rawText);
    } catch {
      // Keep rawText if not JSON
    }
    return {
      ok: !res.isError,
      data,
      rawText,
      elapsedMs,
    };
  }
}
