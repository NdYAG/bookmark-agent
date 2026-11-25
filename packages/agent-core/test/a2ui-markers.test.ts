import { describe, expect, it } from "vitest";
import { splitTextBySurfaces, type ExpandedBookmarkItem } from "@bookmark-agent/catalog";
import { A2uiGenerator, compileA2uiText, convertToLlm } from "../src/index.js";

const card = (id: string) => "```a2ui\n" + JSON.stringify({ components: [{ component: "CollectionCard", props: { id } }] }) + "\n```";

const lookup = async (ids: string[]): Promise<ExpandedBookmarkItem[]> =>
  ids.map((id) => ({
    id,
    source: "x",
    url: `https://x.com/i/${id}`,
    title: `title ${id}`,
    excerpt: null,
    author: "@a",
    cover_url: null,
    media_type: "post",
    publish_date: null,
    category: null,
  }));

describe("A2UI surface position markers", () => {
  it("leaves a marker where each block was, in order, and drops blocks that fail", () => {
    const text = `开头\n\n${card("x:1111111")}\n\n中间段落\n\n${card("x:2222222")}\n\n结尾`;
    const res = compileA2uiText(text);
    expect(res.ok).toBe(true);
    expect(res.plainText).toBe("开头\n\n<!--a2ui:0-->\n\n中间段落\n\n<!--a2ui:1-->\n\n结尾");

    const broken = compileA2uiText(`前\n\n\`\`\`a2ui\n{not json}\n\`\`\`\n\n后`);
    expect(broken.ok).toBe(false);
    expect(broken.plainText).toBe("前\n\n后");
  });

  it("finishTurn keeps markers aligned with expanded surfaces", async () => {
    const gen = new A2uiGenerator(lookup);
    const stream = gen.openStream();
    stream.feed(`可以参考以下收藏：\n\n${card("x:1111111")}\n\n**总结建议**：从这里开始。`);
    const out = await stream.finishTurn();
    expect(out.compileSuccess).toBe(true);
    const segs = splitTextBySurfaces(out.plainText, out.surfaces);
    expect(segs.map((s) => s.kind)).toEqual(["text", "surface", "text"]);
    expect(segs[2]).toEqual({ kind: "text", text: "**总结建议**：从这里开始。" });
    expect((segs[1] as any).surface.components[0].props.item.title).toBe("title x:1111111");
  });

  it("appends surfaces of messages saved without markers, and ignores dangling markers", () => {
    const surfaces = [{ surfaceId: "main", components: [{ component: "CollectionCard" as const, props: { id: "x:1" } }] }];
    expect(splitTextBySurfaces("旧消息正文", surfaces).map((s) => s.kind)).toEqual(["text", "surface"]);
    expect(splitTextBySurfaces("前<!--a2ui:3-->后", [])).toEqual([
      { kind: "text", text: "前" },
      { kind: "text", text: "后" },
    ]);
  });

  it("puts the active surface back in place when building LLM history", () => {
    const llm = convertToLlm([
      { role: "user", type: "text", text: "问" },
      {
        role: "assistant",
        type: "assistant_response",
        text: "前文\n\n<!--a2ui:0-->\n\n后文",
        surfaces: [{ surfaceId: "main", components: [{ component: "CollectionCard", props: { id: "x:1111111" } }] }],
      },
    ]);
    const content = llm[1].content;
    expect(content).not.toContain("<!--a2ui");
    expect(content.indexOf("前文")).toBeLessThan(content.indexOf("A2UI Surface"));
    expect(content.indexOf("A2UI Surface")).toBeLessThan(content.indexOf("后文"));
  });
});

describe("A2UI streaming", () => {
  it("keeps streaming text after a closed block, with a marker in its place", async () => {
    const deltas: string[] = [];
    const gen = new A2uiGenerator(lookup);
    const stream = gen.openStream((ev) => {
      if (ev.type === "text_delta") deltas.push(ev.delta);
    });
    const full = `第一部分\n\n${card("x:1111111")}\n\n第二部分正文\n\n${card("x:2222222")}\n\n总结`;
    // Feed in small chunks so fences arrive split across deltas
    for (let i = 0; i < full.length; i += 5) stream.feed(full.slice(i, i + 5));

    const beforeFinish = deltas.join("");
    expect(beforeFinish).toContain("第二部分正文");
    expect(beforeFinish).not.toContain("```");
    expect(beforeFinish).not.toContain("CollectionCard");
    expect(beforeFinish.match(/<!--a2ui:\d-->/g)).toEqual(["<!--a2ui:0-->", "<!--a2ui:1-->"]);

    const out = await stream.finishTurn();
    const streamed = deltas.join("");
    expect(streamed.endsWith("总结")).toBe(true);
    expect(splitTextBySurfaces(streamed, [], { keepPending: true }).map((s) => s.kind)).toEqual([
      "text",
      "pending",
      "text",
      "pending",
      "text",
    ]);
    expect(splitTextBySurfaces(out.plainText, out.surfaces).map((s) => s.kind)).toEqual([
      "text",
      "surface",
      "text",
      "surface",
      "text",
    ]);
  });

  it("holds an unclosed block back until the turn ends", async () => {
    const deltas: string[] = [];
    const stream = new A2uiGenerator(lookup).openStream((ev) => {
      if (ev.type === "text_delta") deltas.push(ev.delta);
    });
    stream.feed('前文\n\n```a2ui\n{"components": [');
    expect(deltas.join("")).toBe("前文\n\n");
    const out = await stream.finishTurn();
    expect(out.degradedToPlainText).toBe(true);
    expect(out.plainText).toBe("前文");
  });
});
