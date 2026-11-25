import { describe, expect, it } from "vitest";
import {
  collectReferencedItemIds,
  decompileSurfaceToExpress,
  expandCatalogMacros,
  summarizeSurfaceForHistory,
  validateCatalogNode,
} from "../src/index.js";

describe("A1 · A2UI Catalog Schema, Macro Expansion & Express Decompiler", () => {
  it("validates Basic and Macro catalog components", () => {
    const validCard = validateCatalogNode({
      component: "CollectionCard",
      props: { id: "x:1000000000000000008", highlight: "120fps WebGPU" },
    });
    expect(validCard.ok).toBe(true);

    const invalidCard = validateCatalogNode({
      component: "CollectionCard",
      props: { id: "" },
    });
    expect(invalidCard.ok).toBe(false);
  });

  it("expands macros via server lookup and reports missing IDs", async () => {
    const res = await expandCatalogMacros(
      [
        {
          component: "CollectionCard",
          props: { id: "x:1000000000000000008" },
        },
        {
          component: "CollectionCard",
          props: { id: "x:9999999999999999999" },
        },
      ],
      async () => [
        {
          id: "x:1000000000000000008",
          source: "x",
          url: "https://x.com/i/status/1000000000000000008",
          title: "WebGPU Canvas",
          excerpt: "120fps",
          author: "@gpu_craft",
          cover_url: null,
          media_type: "post",
          publish_date: null,
          category: null,
        },
      ],
    );

    expect(res.nodes[0].props.item?.author).toBe("@gpu_craft");
    expect(res.missingIds).toEqual(["x:9999999999999999999"]);
  });

  it("decompiles active surface to Express and summarizes historical surfaces", () => {
    const surface = {
      surfaceId: "main",
      components: [
        {
          component: "CollectionCard" as const,
          props: { id: "x:1000000000000000008", highlight: "Core reference" },
        },
      ],
    };

    const express = decompileSurfaceToExpress(surface);
    expect(express).toContain('surface("main")');
    expect(express).toContain('CollectionCard(id="x:1000000000000000008"');

    const summary = summarizeSurfaceForHistory(surface);
    expect(summary).toContain("[历史 A2UI Surface #main");
    expect(collectReferencedItemIds(surface.components)).toEqual(["x:1000000000000000008"]);
  });
});
