import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownText } from "../src/renderer/components/MarkdownText.js";

const render = (text: string) => renderToStaticMarkup(React.createElement(MarkdownText, { text }));

describe("MarkdownText", () => {
  it("renders GFM headings, emphasis, lists and tables", () => {
    const html = render("### 核心实现\n\n**点半径**：决定大小\n\n* a\n* b\n\n| k | v |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<h3>核心实现</h3>");
    expect(html).toContain("<strong>点半径</strong>");
    expect(html).toMatch(/<ul>\s*<li>a<\/li>/);
    expect(html).toContain('<div class="md-table-wrap"><table>');
    expect(html).not.toContain("###");
  });

  it("turns bookmark ids in text and inline code into chips, but not inside links", () => {
    const html = render(
      "参考 x:1000000000000000001 与 `xhs:600000000000000000000009`，以及 [原帖 x:1000000000000000001](https://x.com/a)",
    );
    expect(html.match(/class="md-bookmark-chip"/g)).toHaveLength(2);
    expect(html).toContain('title="在收藏中定位 x:1000000000000000001"');
    expect(html).toContain("🔖 xhs:…000009");
    expect(html).toContain('<a href="https://x.com/a">原帖 x:1000000000000000001</a>');
  });

  it("drops raw HTML and unsafe link protocols from model output", () => {
    const html = render('看这里 <img src=x onerror="alert(1)"> <script>alert(1)</script> [点我](javascript:alert(1))');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });
});
