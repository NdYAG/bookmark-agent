import type { A2uiSurfaceSpec } from "@bookmark-agent/catalog";
import { A2uiGenerator, type A2uiStreamEvent } from "./a2ui.js";
import type { LlmFunctionCall, LlmProvider } from "./llm.js";
import type { BeforeToolCallHook, CollectionsMcpBridge } from "./mcp-bridge.js";
import {
  type AgentMessage,
  type AssistantAgentMessage,
  type ToolCallRecord,
  convertToLlm,
} from "./messages.js";
import { buildAgentSystemPrompt } from "./prompt.js";
import type { AppSessionStore } from "./session-store.js";

export type BookmarkAgentStreamEvent =
  | { type: "turn_start"; sessionId: string }
  | { type: "tool_call_start"; name: string; args: Record<string, unknown> }
  | {
      type: "tool_call_end";
      name: string;
      args: Record<string, unknown>;
      ok: boolean;
      blockedByConfirmation?: boolean;
      elapsedMs: number;
    }
  | A2uiStreamEvent
  | {
      type: "turn_complete";
      sessionId: string;
      message: AssistantAgentMessage;
      metrics: {
        firstTokenLatencyMs: number;
        firstPaintLatencyMs: number;
        totalLatencyMs: number;
        compileAttempts: number;
        compileSuccess: boolean;
      };
    };

export interface BookmarkAgentOptions {
  mcpBridge: CollectionsMcpBridge;
  llm: LlmProvider;
  sessionStore: AppSessionStore;
  extraSystemPrompt?: string;
  maxToolIterations?: number;
  beforeToolCall?: BeforeToolCallHook;
}

/**
 * BookmarkAgent (pi-agent-core compatible agent loop + pi-mcp + A2UI processor):
 * Transport-agnostic core shared by `dev-web` (SSE) and Electron (`utilityProcess` IPC).
 */
export class BookmarkAgent {
  readonly mcpBridge: CollectionsMcpBridge;
  readonly llm: LlmProvider;
  readonly sessionStore: AppSessionStore;
  readonly a2ui: A2uiGenerator;
  private readonly systemPrompt: string;
  private readonly maxToolIterations: number;

  constructor(opts: BookmarkAgentOptions) {
    this.mcpBridge = opts.mcpBridge;
    this.llm = opts.llm;
    this.sessionStore = opts.sessionStore;
    if (opts.beforeToolCall) {
      this.mcpBridge.setBeforeToolCall(opts.beforeToolCall);
    }
    this.a2ui = new A2uiGenerator((ids) => this.mcpBridge.lookupItemsByIds(ids));
    this.systemPrompt = buildAgentSystemPrompt(opts.extraSystemPrompt);
    this.maxToolIterations = opts.maxToolIterations ?? 5;
  }

  /**
   * Executes a full agent turn:
   * 1. Appends incoming user message (`text`, `attached_items`, or `ui_action`) to `app.db` session.
   * 2. Converts history via `convertToLlm` (Express decompilation for active surface, 1-line summary for old surfaces).
   * 3. Runs tool loop against LLM-facing MCP tools (`app_*` tools filtered out, `beforeToolCall` enforced for writes).
   * 4. Streams `text_delta` into `A2uiGenerator.openStream().feed()` -> compiles & expands macros (`CollectionCard(id)` -> `get_items`).
   * 5. Retries once on A2UI compile or missing-ID error via `finishTurn`, falling back to plain text if retry fails.
   * 6. Saves the final `AssistantAgentMessage` (with A2UI surfaces) to `app.db`.
   */
  async runTurn(
    sessionId: string,
    userMessage: AgentMessage,
    onEvent?: (ev: BookmarkAgentStreamEvent) => void,
  ): Promise<{
    sessionId: string;
    message: AssistantAgentMessage;
    surfaces: A2uiSurfaceSpec[];
    toolCalls: ToolCallRecord[];
    metrics: {
      firstTokenLatencyMs: number;
      firstPaintLatencyMs: number;
      totalLatencyMs: number;
      compileAttempts: number;
      compileSuccess: boolean;
    };
  }> {
    const turnT0 = Date.now();
    this.sessionStore.getOrCreateSession(sessionId);
    this.sessionStore.appendMessage(sessionId, userMessage);

    onEvent?.({ type: "turn_start", sessionId });

    const history = this.sessionStore.getSessionMessages(sessionId);
    const llmContextMessages = convertToLlm(history);
    const llmTools = this.mcpBridge.getLlmTools();

    const toolHistory: Array<{
      call: LlmFunctionCall;
      result: unknown;
      rawContentPart?: Record<string, unknown>;
    }> = [];
    const recordedToolCalls: ToolCallRecord[] = [];

    let firstTokenLatencyMs = 0;
    let firstPaintLatencyMs = 0;

    const a2uiStream = this.a2ui.openStream((ev) => {
      if (!firstPaintLatencyMs && (ev.type === "text_delta" || ev.type === "surface_ready")) {
        firstPaintLatencyMs = Date.now() - turnT0;
      }
      onEvent?.(ev);
    });

    for (let iter = 0; iter < this.maxToolIterations; iter++) {
      const llmOut = await this.llm.generateTurn({
        systemPrompt: this.systemPrompt,
        messages: llmContextMessages,
        tools: llmTools,
        toolHistory,
        onTextDelta: (delta) => {
          if (!firstTokenLatencyMs) {
            firstTokenLatencyMs = Date.now() - turnT0;
          }
          a2uiStream.feed(delta);
        },
      });

      if (!firstTokenLatencyMs) {
        firstTokenLatencyMs = Date.now() - turnT0;
      }

      if (llmOut.functionCalls.length === 0) {
        break;
      }

      // Execute requested tool calls sequentially
      for (const fc of llmOut.functionCalls) {
        onEvent?.({ type: "tool_call_start", name: fc.name, args: fc.args });
        const toolRes = await this.mcpBridge.callLlmTool(fc.name, fc.args);

        const rec: ToolCallRecord = {
          name: fc.name,
          args: fc.args,
          ok: toolRes.ok,
          blockedByConfirmation: toolRes.blockedByConfirmation,
          elapsedMs: toolRes.elapsedMs,
          resultSummary:
            typeof toolRes.rawText === "string"
              ? toolRes.rawText.slice(0, 300)
              : JSON.stringify(toolRes.data).slice(0, 300),
        };
        recordedToolCalls.push(rec);

        onEvent?.({
          type: "tool_call_end",
          name: fc.name,
          args: fc.args,
          ok: toolRes.ok,
          blockedByConfirmation: toolRes.blockedByConfirmation,
          elapsedMs: toolRes.elapsedMs,
        });

        const matchingRawPart = llmOut.rawModelParts?.find(
          (p) => (p as any).functionCall?.name === fc.name,
        );

        toolHistory.push({
          call: fc,
          result: toolRes.data,
          rawContentPart: matchingRawPart,
        });
      }
    }

    // Finish turn: compile A2UI, expand server-side macros, retry 1x if compilation/ID check fails
    const finished = await a2uiStream.finishTurn(async (repairPrompt) => {
      const repairOut = await this.llm.generateTurn({
        systemPrompt: this.systemPrompt,
        messages: [
          ...llmContextMessages,
          { role: "user", content: repairPrompt },
        ],
        tools: [],
        toolHistory,
      });
      return repairOut.text;
    });

    if (!firstPaintLatencyMs) {
      firstPaintLatencyMs = Date.now() - turnT0;
    }

    const totalLatencyMs = Date.now() - turnT0;

    const assistantMessage: AssistantAgentMessage = {
      role: "assistant",
      type: "assistant_response",
      text: finished.plainText,
      surfaces: finished.surfaces.length > 0 ? finished.surfaces : undefined,
      toolCalls: recordedToolCalls.length > 0 ? recordedToolCalls : undefined,
      referencedIds: finished.referencedIds.length > 0 ? finished.referencedIds : undefined,
      degradedToPlainText: finished.degradedToPlainText || undefined,
      createdAt: new Date().toISOString(),
    };

    this.sessionStore.appendMessage(sessionId, assistantMessage);

    const metrics = {
      firstTokenLatencyMs,
      firstPaintLatencyMs,
      totalLatencyMs,
      compileAttempts: finished.compileAttempts,
      compileSuccess: finished.compileSuccess,
    };

    onEvent?.({
      type: "turn_complete",
      sessionId,
      message: assistantMessage,
      metrics,
    });

    return {
      sessionId,
      message: assistantMessage,
      surfaces: finished.surfaces,
      toolCalls: recordedToolCalls,
      metrics,
    };
  }
}
