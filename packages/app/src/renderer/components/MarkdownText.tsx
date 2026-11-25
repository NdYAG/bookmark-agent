import React from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Bookmark ids as cited by the agent, e.g. `x:1000000000000000001` or `xhs:600000000000000000000001`. */
const BOOKMARK_ID_RE = /\b(x:\d{6,}|xhs:[0-9a-f]{16,})\b/g;
const BOOKMARK_SCHEME = "bookmark:";

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

/**
 * remark plugin: turns bookmark ids in plain text and in inline code into `bookmark:<id>` links,
 * so they render as clickable chips that locate the item in the grid.
 */
function remarkBookmarkIds() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    if (node.type === "link" || node.type === "linkReference") return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === "inlineCode" && child.value) {
        const whole = child.value.trim();
        if (new RegExp(`^${BOOKMARK_ID_RE.source}$`).test(whole)) {
          next.push({ type: "link", url: BOOKMARK_SCHEME + whole, children: [{ type: "text", value: whole }] });
          continue;
        }
      }
      if (child.type === "text" && child.value && BOOKMARK_ID_RE.test(child.value)) {
        BOOKMARK_ID_RE.lastIndex = 0;
        let last = 0;
        for (const m of child.value.matchAll(BOOKMARK_ID_RE)) {
          const start = m.index ?? 0;
          if (start > last) next.push({ type: "text", value: child.value.slice(last, start) });
          next.push({ type: "link", url: BOOKMARK_SCHEME + m[1], children: [{ type: "text", value: m[1] }] });
          last = start + m[0].length;
        }
        if (last < child.value.length) next.push({ type: "text", value: child.value.slice(last) });
        continue;
      }
      walk(child);
      next.push(child);
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}

function urlTransform(url: string): string {
  if (url.startsWith(BOOKMARK_SCHEME)) return url;
  return defaultUrlTransform(url);
}

function shortId(id: string): string {
  const [src, raw] = id.split(":");
  return raw.length > 8 ? `${src}:…${raw.slice(-6)}` : id;
}

interface MarkdownTextProps {
  text: string;
  onCardClick?: (itemId: string) => void;
  className?: string;
}

/**
 * Renders agent Markdown (GFM) as React elements. Raw HTML is dropped: answers quote scraped
 * posts and web pages, so nothing in them may reach the DOM as markup. External links open in
 * the system browser; bookmark ids become chips that jump to the item in the grid.
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({ text, onCardClick, className }) => {
  const components: Components = {
    a: ({ href, children }) => {
      if (href?.startsWith(BOOKMARK_SCHEME)) {
        const id = href.slice(BOOKMARK_SCHEME.length);
        return (
          <button
            type="button"
            className="md-bookmark-chip"
            title={`在收藏中定位 ${id}`}
            onClick={() => onCardClick?.(id)}
          >
            🔖 {shortId(id)}
          </button>
        );
      }
      if (!href) return <>{children}</>;
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            void window.bookmarkApi?.shell.openExternal(href);
          }}
        >
          {children}
        </a>
      );
    },
    table: ({ children }) => (
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
    ),
  };

  return (
    <div className={`md ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBookmarkIds]}
        skipHtml
        urlTransform={urlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};
