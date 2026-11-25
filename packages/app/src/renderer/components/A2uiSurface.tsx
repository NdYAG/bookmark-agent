import React from "react";
import type { A2uiSurfaceSpec, ExpandedBookmarkItem } from "../../shared/types";
import { MarkdownText } from "./MarkdownText";

interface A2uiSurfaceProps {
  surface: A2uiSurfaceSpec;
  onCardClick: (itemId: string) => void;
  developerView?: boolean;
}

function SourceBadge({ source, id }: { source?: string; id?: string }) {
  const src = source || (id?.startsWith("xhs:") ? "xhs" : "x");
  if (src === "xhs") {
    return (
      <span className="source-badge source-xhs" title="小红书" aria-label="小红书">
        📕
      </span>
    );
  }
  if (src === "manual") {
    return (
      <span className="source-badge source-manual" title="手动" aria-label="手动">
        🔗
      </span>
    );
  }
  return (
    <span className="source-badge source-x" title="X" aria-label="X">
      𝕏
    </span>
  );
}

function CardItem({
  item,
  highlight,
  signals,
  developerView = false,
  onClick,
}: {
  item: Partial<ExpandedBookmarkItem> & { id: string };
  highlight?: string;
  signals?: string[];
  developerView?: boolean;
  onClick: (id: string) => void;
}) {
  const title = item.title || item.author || (developerView ? item.id : "(无标题收藏)");
  const excerpt = item.enriched_card?.summary || item.excerpt || "";
  return (
    <div
      className="a2ui-card"
      role="button"
      tabIndex={0}
      onClick={() => onClick(item.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(item.id);
        }
      }}
    >
      <div className="a2ui-card-header">
        <span className="a2ui-card-author">
          <SourceBadge source={item.source} id={item.id} />
          <span>{item.author || (developerView ? item.id : "未知作者")}</span>
        </span>
        {developerView && <code>{item.id}</code>}
      </div>
      <div className="a2ui-card-title">{title}</div>
      {excerpt && <div className="a2ui-card-excerpt">{excerpt}</div>}
      {highlight && <div className="a2ui-card-highlight">💡 {highlight}</div>}
      {signals && signals.length > 0 && (
        <div className="pill-row">
          {signals.map((s) => (
            <span key={s} className="signal-pill">
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export const A2uiSurface: React.FC<A2uiSurfaceProps> = ({
  surface,
  onCardClick,
  developerView = false,
}) => {
  if (!surface?.components?.length) return null;

  return (
    <div className="a2ui-surface">
      {surface.components.map((node, idx) => {
        const p = node.props || {};
        const key = node.id || `${node.component}-${idx}`;

        if (node.component === "Text") {
          return (
            <MarkdownText key={key} className="a2ui-text" text={String(p.text ?? "")} onCardClick={onCardClick} />
          );
        }

        if (node.component === "BadgeList") {
          return (
            <div key={key} className="pill-row">
              {(p.items || []).map((b: string) => (
                <span key={b} className="meta-pill">
                  {b}
                </span>
              ))}
            </div>
          );
        }

        if (node.component === "CollectionCard") {
          const item = p.item || { id: p.id, title: p.id };
          return (
            <CardItem
              key={key}
              item={item}
              highlight={p.highlight}
              signals={p.signals}
              developerView={developerView}
              onClick={onCardClick}
            />
          );
        }

        if (node.component === "ItemGrid") {
          return (
            <div key={key} className="a2ui-block">
              {p.title && <div className="a2ui-block-title">{p.title}</div>}
              <div className="a2ui-grid">
                {(p.items || []).map((it: ExpandedBookmarkItem) => (
                  <CardItem
                    key={it.id}
                    item={it}
                    highlight={p.notes?.[it.id]}
                    developerView={developerView}
                    onClick={onCardClick}
                  />
                ))}
              </div>
            </div>
          );
        }

        if (node.component === "ThemeCompare") {
          return (
            <div key={key} className="a2ui-block">
              <div className="a2ui-block-title">⚖️ {p.title || "主题对比"}</div>
              <div className="a2ui-compare">
                {(p.columns || []).map((col: any, ci: number) => (
                  <div key={ci} className="a2ui-compare-col">
                    <div className="a2ui-col-title">{col.theme}</div>
                    <div className="a2ui-col-summary">{col.summary}</div>
                    <div className="a2ui-col-cards">
                      {(col.items || []).map((it: ExpandedBookmarkItem) => (
                        <CardItem
                          key={it.id}
                          item={it}
                          developerView={developerView}
                          onClick={onCardClick}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        }

        if (node.component === "Timeline") {
          return (
            <div key={key} className="a2ui-block">
              <div className="a2ui-block-title">🕒 {p.title || "时间线"}</div>
              <div className="a2ui-timeline">
                {(p.steps || []).map((step: any, si: number) => (
                  <div key={si} className="a2ui-compare-col">
                    <div className="a2ui-col-title">
                      {step.label} {step.date ? `(${step.date})` : ""}
                    </div>
                    <div className="a2ui-col-summary">{step.takeaway}</div>
                    <div className="a2ui-col-cards">
                      {(step.items || []).map((it: ExpandedBookmarkItem) => (
                        <CardItem
                          key={it.id}
                          item={it}
                          developerView={developerView}
                          onClick={onCardClick}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
};
