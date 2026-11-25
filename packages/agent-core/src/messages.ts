import {
  type A2uiSurfaceSpec,
  type ExpandedBookmarkItem,
  decompileSurfaceToExpress,
  splitTextBySurfaces,
  summarizeSurfaceForHistory,
} from "@bookmark-agent/catalog";

export interface AttachedItemsMessage {
  role: "user";
  type: "attached_items";
  id?: string;
  items: Array<{
    id: string;
    title?: string | null;
    excerpt?: string | null;
    author?: string | null;
    url?: string;
  }>;
  prompt?: string;
  createdAt?: string;
}

export interface UiActionMessage {
  role: "user";
  type: "ui_action";
  id?: string;
  surfaceId: string;
  action: string;
  itemId?: string;
  context?: Record<string, unknown>;
  createdAt?: string;
}

export interface UserTextMessage {
  role: "user";
  type: "text";
  id?: string;
  text: string;
  attachedItems?: AttachedItemsMessage["items"];
  createdAt?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  resultSummary?: string;
  ok: boolean;
  blockedByConfirmation?: boolean;
  elapsedMs: number;
}

export interface AssistantAgentMessage {
  role: "assistant";
  type: "assistant_response";
  id?: string;
  text: string;
  surfaces?: A2uiSurfaceSpec[];
  toolCalls?: ToolCallRecord[];
  referencedIds?: string[];
  degradedToPlainText?: boolean;
  createdAt?: string;
}

export type AgentMessage =
  | UserTextMessage
  | AttachedItemsMessage
  | UiActionMessage
  | AssistantAgentMessage;

export interface LlmContextMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Sanitizes untrusted `action.context` or `dataModel` values (execution-plan.md §5 Security:
 * "action.context and dataModel are treated as untrusted input").
 */
export function sanitizeUntrustedContext(raw: unknown, maxLen = 600): string {
  try {
    const str = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    return str.replace(/```/g, "'''").slice(0, maxLen);
  } catch {
    return "{}";
  }
}

/**
 * `convertToLlm` (execution-plan.md A1:
 * - Converts `attached_items` (items selected from Grid) into structured ID list + concise summary
 * - Converts `ui_action` into safe untrusted action payload
 * - Manages A2UI Surface context: only the MOST RECENT assistant surface is decompiled into Express syntax;
 *   all older surfaces are replaced with compact 1-line summaries (`summarizeSurfaceForHistory`) to save tokens).
 */
export function convertToLlm(messages: AgentMessage[]): LlmContextMessage[] {
  // Find index of the latest assistant message that contains A2UI surfaces
  let latestSurfaceMsgIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.surfaces && m.surfaces.length > 0) {
      latestSurfaceMsgIdx = i;
      break;
    }
  }

  return messages.map((msg, idx): LlmContextMessage => {
    if (msg.role === "user") {
      if (msg.type === "attached_items") {
        const itemsBlock = msg.items
          .map((it) => {
            const summary = (it.excerpt || it.title || "").replace(/\s+/g, " ").slice(0, 220);
            return `- [${it.id}] ${it.author ? `${it.author}: ` : ""}${summary}`;
          })
          .join("\n");
        const userQuestion = msg.prompt?.trim() || "请结合这些选中的收藏进行分析。";
        return {
          role: "user",
          content: `[用户在 Grid 中选中并附加了 ${msg.items.length} 条收藏]\n${itemsBlock}\n\n用户问题: ${userQuestion}`,
        };
      }

      if (msg.type === "ui_action") {
        const safeCtx = sanitizeUntrustedContext(msg.context);
        return {
          role: "user",
          content:
            `[用户在 A2UI Surface "${msg.surfaceId}" 触发了动作 "${msg.action}"` +
            `${msg.itemId ? ` (关联收藏 ID: ${msg.itemId})` : ""}]\n` +
            `Untrusted action.context: ${safeCtx}`,
        };
      }

      // Standard user text message (optionally with inline attachedItems)
      if (msg.attachedItems && msg.attachedItems.length > 0) {
        const itemsBlock = msg.attachedItems
          .map((it) => {
            const summary = (it.excerpt || it.title || "").replace(/\s+/g, " ").slice(0, 220);
            return `- [${it.id}] ${it.author ? `${it.author}: ` : ""}${summary}`;
          })
          .join("\n");
        return {
          role: "user",
          content: `[附加收藏上下文 (${msg.attachedItems.length} 条)]\n${itemsBlock}\n\n${msg.text}`,
        };
      }

      return {
        role: "user",
        content: msg.text,
      };
    }

    // Assistant message: apply surface context management, keeping each surface where the
    // model wrote it (text carries `<!--a2ui:N-->` markers; older messages get them appended)
    const isActive = idx === latestSurfaceMsgIdx;
    const parts = splitTextBySurfaces(msg.text || "", msg.surfaces || []).map((seg) => {
      if (seg.kind === "text") return seg.text;
      if (seg.kind === "pending") return ""; // only produced with keepPending (streaming previews)
      // Current active surface: decompile to Express format in context; older: compact summary
      return isActive
        ? `[当前活动 A2UI Surface (Express)]\n${decompileSurfaceToExpress(seg.surface)}`
        : summarizeSurfaceForHistory(seg.surface);
    });

    return {
      role: "assistant",
      content: parts.join("\n\n").trim(),
    };
  });
}

/**
 * Helper to build an `AttachedItemsMessage` from full `ExpandedBookmarkItem[]`.
 */
export function createAttachedItemsMessage(
  items: ExpandedBookmarkItem[],
  prompt?: string,
): AttachedItemsMessage {
  return {
    role: "user",
    type: "attached_items",
    items: items.map((it) => ({
      id: it.id,
      title: it.title,
      excerpt: it.enriched_card?.summary || it.excerpt,
      author: it.author,
      url: it.url,
    })),
    prompt,
    createdAt: new Date().toISOString(),
  };
}
