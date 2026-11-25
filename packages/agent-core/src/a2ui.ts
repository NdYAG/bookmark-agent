import {
  A2UI_CATALOG_PROMPT_SNIPPET,
  type A2uiComponentNode,
  type A2uiSurfaceSpec,
  type ExpandedBookmarkItem,
  collectReferencedItemIds,
  expandCatalogMacros,
  stripSurfaceMarkers,
  surfaceMarker,
  validateCatalogNode,
} from "@bookmark-agent/catalog";

export type A2uiStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "surface_start"; surfaceId: string }
  | { type: "surface_ready"; surface: A2uiSurfaceSpec }
  | { type: "compile_error"; error: string; rawBlock: string }
  | { type: "fallback_plain_text"; text: string; reason: string };

export interface A2uiCompileResult {
  ok: boolean;
  /** Prose with a `<!--a2ui:N-->` marker where each compiled block (surface N) appeared. */
  plainText: string;
  surfaces: A2uiSurfaceSpec[];
  errors: string[];
  rawA2uiBlocks: string[];
}

/**
 * Extracts ```a2ui ... ``` or ```json ... ``` (when containing A2UI surface components)
 * and plain text from a full LLM output string.
 */
export function extractA2uiBlocks(fullText: string): {
  plainText: string;
  blocks: string[];
  /** Text with a `blockPlaceholder(i)` token where block i was, for `placeSurfaceMarkers`. */
  template: string;
} {
  const blocks: string[] = [];
  const fenceRegex = /```(?:a2ui|A2UI)\s*\n([\s\S]*?)```/g;
  const template = fullText.replace(fenceRegex, (_m, body: string) => {
    blocks.push(body.trim());
    return blockPlaceholder(blocks.length - 1);
  });
  return { plainText: placeSurfaceMarkers(template, new Map()), blocks, template };
}

function blockPlaceholder(blockIndex: number): string {
  return `\u0000A2UI_BLOCK_${blockIndex}\u0000`;
}

/** Replaces block placeholders with surface markers (or nothing, for blocks that did not compile). */
function placeSurfaceMarkers(template: string, blockToSurface: Map<number, number>): string {
  return template
    .replace(/\u0000A2UI_BLOCK_(\d+)\u0000/g, (_m, i: string) => {
      const surfaceIndex = blockToSurface.get(Number(i));
      return surfaceIndex === undefined ? "\n\n" : `\n\n${surfaceMarker(surfaceIndex)}\n\n`;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parses and validates raw A2UI JSON block(s) against the Catalog schema.
 */
export function compileA2uiText(fullText: string): A2uiCompileResult {
  const { plainText, blocks, template } = extractA2uiBlocks(fullText);

  // Also detect if there is an unclosed ```a2ui fence (truncated or malformed block)
  if (/```(?:a2ui|A2UI)\b/i.test(cleanedOrRawCheck(fullText, blocks))) {
    return {
      ok: false,
      plainText: fullText.replace(/```(?:a2ui|A2UI)[\s\S]*$/i, "").trim(),
      surfaces: [],
      errors: ["Unclosed ```a2ui code fence in model response"],
      rawA2uiBlocks: [fullText],
    };
  }

  if (blocks.length === 0) {
    return {
      ok: true,
      plainText,
      surfaces: [],
      errors: [],
      rawA2uiBlocks: [],
    };
  }

  const surfaces: A2uiSurfaceSpec[] = [];
  const errors: string[] = [];
  const blockToSurface = new Map<number, number>();

  for (let i = 0; i < blocks.length; i++) {
    const raw = blocks[i];
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      errors.push(`A2UI block #${i + 1} JSON syntax error: ${err?.message || String(err)}`);
      continue;
    }

    // Normalize single component object vs array vs full surface object
    let rawComponents: any[] = [];
    let surfaceId = `surface_${i + 1}`;
    let title: string | undefined;
    let dataModel: Record<string, unknown> | undefined;

    if (Array.isArray(parsed)) {
      rawComponents = parsed;
    } else if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.components)) {
        rawComponents = parsed.components;
        if (typeof parsed.surfaceId === "string" && parsed.surfaceId.trim()) {
          surfaceId = parsed.surfaceId.trim();
        }
        if (typeof parsed.title === "string") title = parsed.title;
        if (parsed.dataModel && typeof parsed.dataModel === "object") {
          dataModel = parsed.dataModel;
        }
      } else if (typeof parsed.component === "string") {
        rawComponents = [parsed];
      } else {
        errors.push(
          `A2UI block #${i + 1} must contain a "components" array or a single "component" object`,
        );
        continue;
      }
    } else {
      errors.push(`A2UI block #${i + 1} must be a JSON object or array`);
      continue;
    }

    if (rawComponents.length === 0) {
      errors.push(`A2UI block #${i + 1} has an empty "components" array`);
      continue;
    }

    const validatedNodes: A2uiComponentNode[] = [];
    for (let cIdx = 0; cIdx < rawComponents.length; cIdx++) {
      const v = validateCatalogNode(rawComponents[cIdx]);
      if (!v.ok || !v.node) {
        errors.push(`A2UI block #${i + 1} component[${cIdx}]: ${v.error}`);
      } else {
        validatedNodes.push(v.node);
      }
    }

    if (validatedNodes.length > 0 && errors.length === 0) {
      blockToSurface.set(i, surfaces.length);
      surfaces.push({
        surfaceId,
        title,
        components: validatedNodes,
        dataModel,
      });
    }
  }

  return {
    ok: errors.length === 0,
    plainText: placeSurfaceMarkers(template, blockToSurface),
    surfaces,
    errors,
    rawA2uiBlocks: blocks,
  };
}

function cleanedOrRawCheck(fullText: string, extractedBlocks: string[]): string {
  let rem = fullText;
  for (const b of extractedBlocks) {
    rem = rem.replace(b, "");
  }
  rem = rem.replace(/```(?:a2ui|A2UI)\s*\n\s*```/g, "");
  return rem;
}

/**
 * A2uiGenerator: thin isolation wrapper around A2UI streaming compilation,
 * server-side macro expansion, 1x finishTurn retry on compile failure, and graceful fallback to plain text.
 */
export class A2uiGenerator {
  readonly promptSnippet = A2UI_CATALOG_PROMPT_SNIPPET;

  constructor(
    private readonly lookupItems: (ids: string[]) => Promise<ExpandedBookmarkItem[]>,
  ) {}

  /**
   * Opens a streaming compilation session (`text_delta` -> `openStream().feed()`).
   * Streams plain text deltas immediately while buffering ```a2ui ... ``` blocks for compilation.
   */
  openStream(onEvent?: (ev: A2uiStreamEvent) => void) {
    let buffer = "";
    /** Everything before this offset has been emitted (as text, or consumed as a block). */
    let emittedPlainLength = 0;
    let insideFence = false;
    let fenceStart = -1;
    let blocksSeen = 0;

    const emitText = (end: number) => {
      if (end > emittedPlainLength) {
        onEvent?.({ type: "text_delta", delta: buffer.slice(emittedPlainLength, end) });
        emittedPlainLength = end;
      }
    };

    /**
     * Streams prose immediately, holds each ```a2ui block until it closes, then emits a
     * `<!--a2ui:N-->` marker in its place and keeps streaming the text that follows. The marker
     * index is the block's ordinal; the final message (finishTurn) renumbers markers by compiled
     * surface, so a block that fails to compile only affects the in-flight preview.
     */
    const feed = (textDelta: string) => {
      if (!textDelta) return;
      buffer += textDelta;

      for (;;) {
        if (!insideFence) {
          const lower = buffer.indexOf("```a2ui", emittedPlainLength);
          const upper = buffer.indexOf("```A2UI", emittedPlainLength);
          const idx = lower >= 0 && upper >= 0 ? Math.min(lower, upper) : Math.max(lower, upper);
          if (idx < 0) {
            // Hold back up to 8 trailing characters in case a ```a2ui fence is starting
            emitText(Math.max(emittedPlainLength, buffer.length - 8));
            return;
          }
          emitText(idx);
          insideFence = true;
          fenceStart = idx;
          onEvent?.({ type: "surface_start", surfaceId: `block_${blocksSeen}` });
        }

        // Inside a block: wait for the closing fence (same rule as the compile regex)
        const bodyStart = buffer.indexOf("\n", fenceStart);
        const close = bodyStart < 0 ? -1 : buffer.indexOf("```", bodyStart);
        if (close < 0) return;
        const afterClose = close + 3;
        onEvent?.({ type: "text_delta", delta: `\n\n${surfaceMarker(blocksSeen)}\n\n` });
        blocksSeen++;
        emittedPlainLength = afterClose;
        insideFence = false;
        fenceStart = -1;
      }
    };

    /**
     * Completes the turn:
     * 1. Flushes any remaining plain text outside ```a2ui fences.
     * 2. Compiles A2UI blocks & validates all referenced bookmark IDs exist in DB.
     * 3. If compilation or ID validation fails, invokes `retryGenerate(repairPrompt)` ONCE.
     * 4. If the retry also fails, degrades gracefully to plain text without crashing.
     */
    const finishTurn = async (
      retryGenerate?: (repairPrompt: string) => Promise<string>,
    ): Promise<{
      plainText: string;
      surfaces: A2uiSurfaceSpec[];
      compileAttempts: number;
      compileSuccess: boolean;
      degradedToPlainText: boolean;
      errors: string[];
      referencedIds: string[];
      missingIds: string[];
    }> => {
      // Flush the held-back tail (an unclosed block stays unflushed and is handled by compile)
      if (!insideFence) emitText(buffer.length);

      const attemptCompileAndExpand = async (rawText: string) => {
        const compiled = compileA2uiText(rawText);
        if (!compiled.ok) {
          return {
            ok: false,
            plainText: compiled.plainText,
            surfaces: [] as A2uiSurfaceSpec[],
            errors: compiled.errors,
            referencedIds: [] as string[],
            missingIds: [] as string[],
          };
        }

        const expandedSurfaces: A2uiSurfaceSpec[] = [];
        const allReferenced = new Set<string>();
        const allMissing = new Set<string>();

        for (const surf of compiled.surfaces) {
          for (const id of collectReferencedItemIds(surf.components)) {
            allReferenced.add(id);
          }
          const exp = await expandCatalogMacros(surf.components, this.lookupItems);
          for (const m of exp.missingIds) {
            allMissing.add(m);
          }
          expandedSurfaces.push({
            ...surf,
            components: exp.nodes,
          });
        }

        if (allMissing.size > 0) {
          return {
            ok: false,
            plainText: compiled.plainText,
            surfaces: expandedSurfaces,
            errors: [
              `Referenced non-existent bookmark ID(s): ${Array.from(allMissing).join(", ")}. You must only cite real IDs returned by search/get_items/read_item/related.`,
            ],
            referencedIds: Array.from(allReferenced),
            missingIds: Array.from(allMissing),
          };
        }

        return {
          ok: true,
          plainText: compiled.plainText,
          surfaces: expandedSurfaces,
          errors: [] as string[],
          referencedIds: Array.from(allReferenced),
          missingIds: [] as string[],
        };
      };

      // Attempt 1
      let res = await attemptCompileAndExpand(buffer);
      let attempts = 1;

      if (res.ok) {
        for (const surf of res.surfaces) {
          onEvent?.({ type: "surface_ready", surface: surf });
        }
        return {
          plainText: res.plainText,
          surfaces: res.surfaces,
          compileAttempts: attempts,
          compileSuccess: true,
          degradedToPlainText: false,
          errors: [],
          referencedIds: res.referencedIds,
          missingIds: [],
        };
      }

      for (const err of res.errors) {
        onEvent?.({ type: "compile_error", error: err, rawBlock: buffer });
      }

      // Attempt 2: Retry once via finishTurn repair prompt if retryGenerate callback is provided
      if (retryGenerate) {
        attempts = 2;
        const repairPrompt =
          `你上一轮输出的 \`\`\`a2ui\`\`\` JSON 代码块编译失败，原因如下：\n` +
          res.errors.map((e) => `- ${e}`).join("\n") +
          `\n\n请修正并重新输出完整的回答（保留你的文字分析，并附上合法的 \`\`\`a2ui\`\`\` JSON 代码块，仅引用真实存在的收藏 ID）。`;
        try {
          const repairedText = await retryGenerate(repairPrompt);
          const res2 = await attemptCompileAndExpand(repairedText);
          if (res2.ok) {
            for (const surf of res2.surfaces) {
              onEvent?.({ type: "surface_ready", surface: surf });
            }
            return {
              plainText: res2.plainText || stripSurfaceMarkers(res.plainText),
              surfaces: res2.surfaces,
              compileAttempts: attempts,
              compileSuccess: true,
              degradedToPlainText: false,
              errors: [],
              referencedIds: res2.referencedIds,
              missingIds: [],
            };
          }
          res = res2;
        } catch (retryErr: any) {
          res.errors.push(`Retry generation failed: ${retryErr?.message || String(retryErr)}`);
        }
      }

      // Graceful fallback to plain text
      const fallbackText =
        stripSurfaceMarkers(res.plainText) ||
        buffer
          .replace(/```(?:a2ui|A2UI)[\s\S]*?```/g, "")
          .replace(/```(?:a2ui|A2UI)[\s\S]*$/g, "")
          .trim() ||
        "（已降级为纯文本展示）";

      onEvent?.({
        type: "fallback_plain_text",
        text: fallbackText,
        reason: res.errors.join("; "),
      });

      return {
        plainText: fallbackText,
        surfaces: [],
        compileAttempts: attempts,
        compileSuccess: false,
        degradedToPlainText: true,
        errors: res.errors,
        referencedIds: res.referencedIds,
        missingIds: res.missingIds,
      };
    };

    return { feed, finishTurn };
  }
}
