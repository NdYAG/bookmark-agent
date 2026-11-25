import { z } from "zod";

export interface ExpandedBookmarkItem {
  id: string;
  source: string;
  source_item_id?: string;
  url: string;
  title: string | null;
  excerpt: string | null;
  note?: string | null;
  author: string | null;
  cover_url: string | null;
  media_type: string | null;
  publish_date: string | null;
  first_seen_at?: string;
  category: string | null;
  enriched_card?: {
    summary?: string;
    topics?: string[];
    kind?: string;
    lang?: string;
    imageCaptions?: string[];
  } | null;
}

export const CollectionCardPropsSchema = z.object({
  id: z.string().min(1),
  highlight: z.string().optional(),
  signals: z.array(z.string()).optional(),
  // Populated by server macro expansion:
  item: z.custom<ExpandedBookmarkItem>().optional(),
  missing: z.boolean().optional(),
});

export const ItemGridPropsSchema = z.object({
  title: z.string().optional(),
  ids: z.array(z.string()).min(1),
  notes: z.record(z.string(), z.string()).optional(),
  // Populated by server macro expansion:
  items: z.array(z.custom<ExpandedBookmarkItem>()).optional(),
  missingIds: z.array(z.string()).optional(),
});

export const ThemeCompareColumnSchema = z.object({
  theme: z.string().min(1),
  summary: z.string().min(1),
  pros: z.array(z.string()).optional(),
  cons: z.array(z.string()).optional(),
  itemIds: z.array(z.string()).min(1),
  items: z.array(z.custom<ExpandedBookmarkItem>()).optional(),
});

export const ThemeComparePropsSchema = z.object({
  title: z.string().min(1),
  dimensions: z.array(z.string()).optional(),
  columns: z.array(ThemeCompareColumnSchema).min(2),
});

export const TimelineStepSchema = z.object({
  label: z.string().min(1),
  date: z.string().optional(),
  takeaway: z.string().min(1),
  itemIds: z.array(z.string()).min(1),
  items: z.array(z.custom<ExpandedBookmarkItem>()).optional(),
});

export const TimelinePropsSchema = z.object({
  title: z.string().min(1),
  steps: z.array(TimelineStepSchema).min(1),
});

export const TextPropsSchema = z.object({
  text: z.string(),
});

export const BadgeListPropsSchema = z.object({
  items: z.array(z.string()),
});

export const SectionPropsSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  children: z.array(z.lazy(() => A2uiComponentNodeSchema)).optional(),
});

export type A2uiComponentType =
  | "Text"
  | "Section"
  | "BadgeList"
  | "CollectionCard"
  | "ItemGrid"
  | "ThemeCompare"
  | "Timeline";

export interface A2uiComponentNode {
  id?: string;
  component: A2uiComponentType;
  props: Record<string, any>;
}

export const A2uiComponentNodeSchema: z.ZodType<A2uiComponentNode> = z.object({
  id: z.string().optional(),
  component: z.enum([
    "Text",
    "Section",
    "BadgeList",
    "CollectionCard",
    "ItemGrid",
    "ThemeCompare",
    "Timeline",
  ]),
  props: z.record(z.string(), z.any()),
});

export interface A2uiSurfaceSpec {
  surfaceId: string;
  title?: string;
  components: A2uiComponentNode[];
  dataModel?: Record<string, unknown>;
}

export const A2uiSurfaceSpecSchema = z.object({
  surfaceId: z.string().default("main"),
  title: z.string().optional(),
  components: z.array(A2uiComponentNodeSchema).min(1),
  dataModel: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Validates an A2uiComponentNode's props against its specific catalog component schema.
 */
export function validateCatalogNode(node: unknown): {
  ok: boolean;
  node?: A2uiComponentNode;
  error?: string;
} {
  const base = A2uiComponentNodeSchema.safeParse(node);
  if (!base.success) {
    return { ok: false, error: base.error.message };
  }
  const { component, props } = base.data;
  const schemaMap: Record<A2uiComponentType, z.ZodTypeAny> = {
    Text: TextPropsSchema,
    Section: SectionPropsSchema,
    BadgeList: BadgeListPropsSchema,
    CollectionCard: CollectionCardPropsSchema,
    ItemGrid: ItemGridPropsSchema,
    ThemeCompare: ThemeComparePropsSchema,
    Timeline: TimelinePropsSchema,
  };
  const schema = schemaMap[component];
  const parsedProps = schema.safeParse(props);
  if (!parsedProps.success) {
    return {
      ok: false,
      error: `Invalid props for <${component}>: ${parsedProps.error.issues
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return {
    ok: true,
    node: {
      id: base.data.id,
      component,
      props: parsedProps.data,
    },
  };
}

/**
 * Extracts all referenced bookmark IDs from a surface or component list.
 */
export function collectReferencedItemIds(nodes: A2uiComponentNode[]): string[] {
  const ids = new Set<string>();
  const normalizeId = (id: string) => (id.includes(":") ? id.trim() : `x:${id.trim()}`);

  const visit = (node: A2uiComponentNode) => {
    const p = node.props || {};
    switch (node.component) {
      case "CollectionCard":
        if (typeof p.id === "string" && p.id.trim()) ids.add(normalizeId(p.id));
        break;
      case "ItemGrid":
        if (Array.isArray(p.ids)) {
          for (const id of p.ids) {
            if (typeof id === "string" && id.trim()) ids.add(normalizeId(id));
          }
        }
        break;
      case "ThemeCompare":
        if (Array.isArray(p.columns)) {
          for (const col of p.columns) {
            if (Array.isArray(col?.itemIds)) {
              for (const id of col.itemIds) {
                if (typeof id === "string" && id.trim()) ids.add(normalizeId(id));
              }
            }
          }
        }
        break;
      case "Timeline":
        if (Array.isArray(p.steps)) {
          for (const step of p.steps) {
            if (Array.isArray(step?.itemIds)) {
              for (const id of step.itemIds) {
                if (typeof id === "string" && id.trim()) ids.add(normalizeId(id));
              }
            }
          }
        }
        break;
      case "Section":
        if (Array.isArray(p.children)) {
          for (const child of p.children) visit(child);
        }
        break;
    }
  };

  for (const n of nodes) visit(n);
  return Array.from(ids);
}

/**
 * Server-side Macro Expander:
 * Given a list of A2uiComponentNodes and a lookup function (backed by MCP `get_items`),
 * expands `CollectionCard(id)`, `ItemGrid([ids])`, `ThemeCompare`, and `Timeline` with real database metadata.
 * The LLM only writes bookmark IDs and never repeats or fabricates metadata.
 */
export async function expandCatalogMacros(
  nodes: A2uiComponentNode[],
  lookupItems: (ids: string[]) => Promise<ExpandedBookmarkItem[]>,
): Promise<{
  nodes: A2uiComponentNode[];
  expandedItems: Record<string, ExpandedBookmarkItem>;
  missingIds: string[];
}> {
  const normalizeId = (id: string) => (id.includes(":") ? id.trim() : `x:${id.trim()}`);
  const allIds = collectReferencedItemIds(nodes);
  const fetched = allIds.length > 0 ? await lookupItems(allIds) : [];

  const itemMap: Record<string, ExpandedBookmarkItem> = {};
  for (const it of fetched) {
    itemMap[it.id] = it;
    if (it.source_item_id) {
      itemMap[it.source_item_id] = it;
      itemMap[`${it.source}:${it.source_item_id}`] = it;
    }
  }

  const missingSet = new Set<string>();

  const expandNode = (node: A2uiComponentNode, idx: number): A2uiComponentNode => {
    const id = node.id || `${node.component.toLowerCase()}_${idx}`;
    const p = { ...node.props };

    if (node.component === "CollectionCard") {
      const normId = normalizeId(String(p.id || ""));
      const item = itemMap[normId] || itemMap[String(p.id || "")];
      if (!item) {
        missingSet.add(normId);
        return { id, component: "CollectionCard", props: { ...p, id: normId, missing: true } };
      }
      return {
        id,
        component: "CollectionCard",
        props: {
          ...p,
          id: item.id,
          item,
        },
      };
    }

    if (node.component === "ItemGrid") {
      const rawIds: string[] = Array.isArray(p.ids) ? p.ids : [];
      const items: ExpandedBookmarkItem[] = [];
      const localMissing: string[] = [];
      const normalizedIds: string[] = [];
      for (const rawId of rawIds) {
        const normId = normalizeId(String(rawId));
        normalizedIds.push(normId);
        const item = itemMap[normId] || itemMap[String(rawId)];
        if (item) {
          items.push(item);
        } else {
          missingSet.add(normId);
          localMissing.push(normId);
        }
      }
      return {
        id,
        component: "ItemGrid",
        props: {
          ...p,
          ids: normalizedIds,
          items,
          missingIds: localMissing.length ? localMissing : undefined,
        },
      };
    }

    if (node.component === "ThemeCompare") {
      const columns = (Array.isArray(p.columns) ? p.columns : []).map((col: any) => {
        const rawIds: string[] = Array.isArray(col.itemIds) ? col.itemIds : [];
        const items: ExpandedBookmarkItem[] = [];
        const normIds: string[] = [];
        for (const rawId of rawIds) {
          const normId = normalizeId(String(rawId));
          normIds.push(normId);
          const item = itemMap[normId] || itemMap[String(rawId)];
          if (item) items.push(item);
          else missingSet.add(normId);
        }
        return {
          ...col,
          itemIds: normIds,
          items,
        };
      });
      return {
        id,
        component: "ThemeCompare",
        props: { ...p, columns },
      };
    }

    if (node.component === "Timeline") {
      const steps = (Array.isArray(p.steps) ? p.steps : []).map((step: any) => {
        const rawIds: string[] = Array.isArray(step.itemIds) ? step.itemIds : [];
        const items: ExpandedBookmarkItem[] = [];
        const normIds: string[] = [];
        for (const rawId of rawIds) {
          const normId = normalizeId(String(rawId));
          normIds.push(normId);
          const item = itemMap[normId] || itemMap[String(rawId)];
          if (item) items.push(item);
          else missingSet.add(normId);
        }
        return {
          ...step,
          itemIds: normIds,
          items,
        };
      });
      return {
        id,
        component: "Timeline",
        props: { ...p, steps },
      };
    }

    if (node.component === "Section" && Array.isArray(p.children)) {
      return {
        id,
        component: "Section",
        props: {
          ...p,
          children: p.children.map((c: A2uiComponentNode, cIdx: number) => expandNode(c, cIdx)),
        },
      };
    }

    return { id, component: node.component, props: p };
  };

  const expandedNodes = nodes.map((n, i) => expandNode(n, i));
  return {
    nodes: expandedNodes,
    expandedItems: itemMap,
    missingIds: Array.from(missingSet),
  };
}

/**
 * Express Decompiler (design.md / execution-plan.md A1 context management):
 * Decompiles an active A2UI surface back into a compact Express expression string
 * for the current conversation turn context, while older surfaces are summarized.
 */
export function decompileSurfaceToExpress(surface: A2uiSurfaceSpec): string {
  const lines: string[] = [`surface("${surface.surfaceId}") {`];
  for (const node of surface.components) {
    switch (node.component) {
      case "CollectionCard":
        lines.push(
          `  CollectionCard(id=${JSON.stringify(node.props.id)}${
            node.props.highlight ? `, highlight=${JSON.stringify(node.props.highlight)}` : ""
          })`,
        );
        break;
      case "ItemGrid":
        lines.push(
          `  ItemGrid(title=${JSON.stringify(node.props.title || "")}, ids=${JSON.stringify(
            node.props.ids || [],
          )})`,
        );
        break;
      case "ThemeCompare":
        lines.push(
          `  ThemeCompare(title=${JSON.stringify(node.props.title)}, themes=${JSON.stringify(
            (node.props.columns || []).map((c: any) => ({
              theme: c.theme,
              itemIds: c.itemIds,
            })),
          )})`,
        );
        break;
      case "Timeline":
        lines.push(
          `  Timeline(title=${JSON.stringify(node.props.title)}, steps=${JSON.stringify(
            (node.props.steps || []).map((s: any) => ({
              label: s.label,
              itemIds: s.itemIds,
            })),
          )})`,
        );
        break;
      default:
        lines.push(`  ${node.component}(${JSON.stringify(node.props)})`);
        break;
    }
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * Summarizes an older A2UI surface into a single compact line for conversation history
 * (saving context tokens on multi-turn chats).
 */
export function summarizeSurfaceForHistory(surface: A2uiSurfaceSpec): string {
  const comps = surface.components.map((c) => c.component).join(", ");
  const ids = collectReferencedItemIds(surface.components);
  return `[历史 A2UI Surface #${surface.surfaceId}: 组件=[${comps}], 引用收藏=[${ids.join(", ")}]]`;
}

/**
 * Fixed A2UI promptSnippet injected into the system prompt prefix.
 */
export const A2UI_CATALOG_PROMPT_SNIPPET = `
## A2UI 生成式界面规范（Catalog: bookmark-agent.collections-v1）

你可以在回答中使用 \`\`\`a2ui ... \`\`\` 代码块渲染富交互组件，或仅用纯文本回答。

### 何时只用纯文本（严禁过度使用 UI！）
- 当用户只是打招呼、闲聊、询问使用方式、询问通用概念定义（且不涉及展示具体收藏卡片）、确认/取消操作、或只需要一句简短统计结论时：**只输出纯文本 Markdown，绝对不要输出 \`\`\`a2ui\`\`\` 块！**

### 何时使用 A2UI 组件
- 当回答中引用了用户的具体收藏条目（1 条或多条）、进行多主题/多方案对比、或梳理时间线/学习路径时，在引用这些收藏的那段文字之后插入 \`\`\`a2ui\`\`\` JSON 代码块：卡片会渲染在代码块所在的位置，代码块之后可以继续写文字（例如下一部分或总结）。
- **数据宏原则（严禁编造或复述元数据）**：所有收藏组件都是服务端宏（Macro）。你只需传入从工具查到的真实收藏 \`id\`（如 \`"x:1000000000000000001"\`）以及你的一句话点评（\`highlight\` / \`notes\` / \`summary\`），服务端会自动调用 \`get_items\` 展开标题、作者、摘要、配图和原链接。**绝对不要编造不存在的收藏 ID！**

### 可用组件 Schema（写在 \`\`\`a2ui 代码块内的 JSON）
\`\`\`json
{
  "surfaceId": "main",
  "title": "可选标题",
  "components": [
    {
      "component": "CollectionCard",
      "props": {
        "id": "x:1000000000000000001",
        "highlight": "为什么引用这条收藏的一句话点评",
        "signals": ["语义相近", "核心参考"]
      }
    },
    {
      "component": "ItemGrid",
      "props": {
        "title": "相关收藏合集",
        "ids": ["x:1000000000000000001", "x:1000000000000000002"],
        "notes": {
          "x:1000000000000000001": "Agent 工具调用与上下文压缩实践",
          "x:1000000000000000002": "MCP 双面工具隔离与权限门控设计"
        }
      }
    },
    {
      "component": "ThemeCompare",
      "props": {
        "title": "方案对比标题",
        "dimensions": ["核心思路", "适用场景"],
        "columns": [
          {
            "theme": "方向 A",
            "summary": "核心做法总结",
            "pros": ["优势 1"],
            "cons": ["局限 1"],
            "itemIds": ["x:1000000000000000001"]
          },
          {
            "theme": "方向 B",
            "summary": "核心做法总结",
            "pros": ["优势 1"],
            "cons": ["局限 1"],
            "itemIds": ["x:1000000000000000015"]
          }
        ]
      }
    },
    {
      "component": "Timeline",
      "props": {
        "title": "演进 / 学习路线",
        "steps": [
          {
            "label": "阶段 1",
            "date": "2026-10",
            "takeaway": "关键收获",
            "itemIds": ["x:1000000000000000028"]
          }
        ]
      }
    }
  ]
}
\`\`\`
`.trim();

/**
 * Position of an A2UI surface inside an assistant message's text. The compiler replaces each
 * ```a2ui block with `<!--a2ui:N-->` (N = index into `surfaces`) so renderers can interleave
 * prose and surfaces in the order the model wrote them. An HTML comment is invisible to any
 * Markdown renderer that ignores raw HTML, so older clients degrade gracefully.
 */
export const SURFACE_MARKER_RE = /<!--a2ui:(\d+)-->/g;

export function surfaceMarker(index: number): string {
  return `<!--a2ui:${index}-->`;
}

export function stripSurfaceMarkers(text: string): string {
  return text.replace(SURFACE_MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "surface"; surface: A2uiSurfaceSpec; index: number }
  /** Marker whose surface has not arrived yet (only with `keepPending`, i.e. while streaming). */
  | { kind: "pending"; index: number };

/**
 * Splits message text at surface markers into ordered text/surface segments. Surfaces without a
 * marker (messages saved before markers existed) are appended at the end, as they used to render.
 */
export function splitTextBySurfaces(
  text: string,
  surfaces: A2uiSurfaceSpec[] = [],
  opts?: { keepPending?: boolean },
): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const placed = new Set<number>();
  let last = 0;
  for (const m of text.matchAll(SURFACE_MARKER_RE)) {
    const index = Number(m[1]);
    const start = m.index ?? 0;
    const before = text.slice(last, start).trim();
    if (before) segments.push({ kind: "text", text: before });
    if (surfaces[index] && !placed.has(index)) {
      segments.push({ kind: "surface", surface: surfaces[index], index });
      placed.add(index);
    } else if (!surfaces[index] && opts?.keepPending) {
      segments.push({ kind: "pending", index });
    }
    last = start + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) segments.push({ kind: "text", text: tail });
  surfaces.forEach((surface, index) => {
    if (!placed.has(index)) segments.push({ kind: "surface", surface, index });
  });
  return segments;
}
