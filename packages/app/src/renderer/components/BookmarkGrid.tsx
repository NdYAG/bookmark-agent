import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  CategoryInfo,
  GridBookmarkItem,
  MetaResponse,
  PendingCategoryItem,
  RelatedCandidateItem,
  RelatedResponse,
  SyncProgressEvent,
} from "../../shared/types";

interface BookmarkGridProps {
  meta: MetaResponse | null;
  items: GridBookmarkItem[];
  total: number;
  loading: boolean;
  hasMore: boolean;
  sourceFilter: string;
  categoryFilter: string;
  mediaTypeFilter: string;
  sortOrder: "first_seen_desc" | "first_seen_asc" | "publish_desc" | "publish_asc";
  searchQuery: string;
  highlightedId: string | null;
  relatedView: RelatedResponse | null;
  relatedLoading: boolean;
  syncProgress: SyncProgressEvent | null;
  developerView?: boolean;
  onChangeSource: (src: string) => void;
  onChangeCategory: (cat: string) => void;
  onChangeMediaType: (mt: string) => void;
  onChangeSort: (s: "first_seen_desc" | "first_seen_asc" | "publish_desc" | "publish_asc") => void;
  onChangeQuery: (q: string) => void;
  onLoadMore: () => void;
  onOpenRelated: (itemId: string) => void;
  onCloseRelated: () => void;
  onDismissRelated: (targetId: string, candidateId: string) => void;
  onAskAgent: (items: GridBookmarkItem[], defaultPrompt?: string) => void;
  onEditItem: (
    id: string,
    patch: { title?: string; note?: string; category?: string },
  ) => Promise<void>;
  onDeleteItem: (id: string) => Promise<void>;
  onOpenExternal: (url: string) => void;
  onConfirmPending: (itemId: string, categoryId: string) => Promise<void>;
}

const SOURCE_INFO: Record<string, { label: string; icon: string; cls: string }> = {
  x: { label: "X", icon: "𝕏", cls: "source-x" },
  xhs: { label: "小红书", icon: "📕", cls: "source-xhs" },
  manual: { label: "手动", icon: "🔗", cls: "source-manual" },
};

const MEDIA_LABELS: Record<string, string> = {
  post: "帖子",
  video: "🎬 视频",
  article: "📄 长文",
  link: "🔗 外链",
};

const GRID_PADDING_X = 28;
const GRID_GAP = 12;
const CARD_MIN_WIDTH = 200;
const CARD_BODY_HEIGHT = 226;
const OVERSCAN_ROWS = 3;
const HIGH_PRECISION_RE = /^精判高相关/;
const SEMANTIC_SIMILAR_RE = /^语义相近/;

function resolveRelatedGroupLabel(
  primarySignal: string | undefined,
  developerView: boolean,
): string {
  const primary = primarySignal || "语义相近";
  if (developerView) return primary;
  if (HIGH_PRECISION_RE.test(primary)) return "精判高相关";
  if (SEMANTIC_SIMILAR_RE.test(primary)) return "语义相近";
  return primary;
}

function coverProxyUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  if (typeof window !== "undefined" && (window as any).bookmarkApi) {
    return `bookmark-cover://fetch?url=${encodeURIComponent(remoteUrl)}`;
  }
  return remoteUrl;
}

export const BookmarkGrid: React.FC<BookmarkGridProps> = ({
  meta,
  items,
  total,
  loading,
  hasMore,
  sourceFilter,
  categoryFilter,
  mediaTypeFilter,
  sortOrder,
  searchQuery,
  highlightedId,
  relatedView,
  relatedLoading,
  syncProgress,
  developerView = false,
  onChangeSource,
  onChangeCategory,
  onChangeMediaType,
  onChangeSort,
  onChangeQuery,
  onLoadMore,
  onOpenRelated,
  onCloseRelated,
  onDismissRelated,
  onAskAgent,
  onEditItem,
  onDeleteItem,
  onOpenExternal,
  onConfirmPending,
}) => {
  const [selectedMap, setSelectedMap] = useState<Map<string, GridBookmarkItem>>(new Map());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: GridBookmarkItem;
  } | null>(null);
  const [editingItem, setEditingItem] = useState<GridBookmarkItem | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [showPending, setShowPending] = useState(false);
  const [pendingItems, setPendingItems] = useState<PendingCategoryItem[]>([]);

  // Virtualized scroll state
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(720);
  const [viewportHeight, setViewportHeight] = useState(640);
  const [scrollTop, setScrollTop] = useState(0);

  const categoryNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of meta?.categories || []) {
      map[c.id] = c.name || c.id;
    }
    return map;
  }, [meta]);

  const categoryCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of meta?.categoryCounts || []) {
      map[c.category] = c.count;
    }
    return map;
  }, [meta]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportWidth(entry.contentRect.width);
        setViewportHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  const cols = Math.max(
    1,
    Math.floor((viewportWidth - GRID_PADDING_X + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP)),
  );
  const cardWidth = Math.max(
    180,
    (viewportWidth - GRID_PADDING_X - (cols - 1) * GRID_GAP) / cols,
  );
  const coverHeight = Math.round(cardWidth);
  const cardHeight = coverHeight + CARD_BODY_HEIGHT;
  const rowHeight = cardHeight + GRID_GAP;

  // Scroll highlighted item into view when triggered from A2UI card click
  useEffect(() => {
    if (!highlightedId || relatedView || !scrollRef.current) return;
    const idx = items.findIndex((it) => it.id === highlightedId);
    if (idx >= 0) {
      const row = Math.floor(idx / cols);
      scrollRef.current.scrollTo({
        top: Math.max(0, row * rowHeight - 80),
        behavior: "smooth",
      });
    }
  }, [highlightedId, items, relatedView, cols, rowHeight]);

  const totalRows = Math.ceil(items.length / cols);
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const visibleRowCount = Math.ceil(viewportHeight / rowHeight) + OVERSCAN_ROWS * 2;
  const endRow = Math.min(totalRows, startRow + visibleRowCount);

  const visibleSlice = useMemo(() => {
    const startIdx = startRow * cols;
    const endIdx = Math.min(items.length, endRow * cols);
    return { startIdx, slice: items.slice(startIdx, endIdx) };
  }, [items, startRow, endRow, cols]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (
      !relatedView &&
      !loading &&
      hasMore &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - 420
    ) {
      onLoadMore();
    }
  };

  const toggleSelect = (item: GridBookmarkItem) => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
  };

  const openEdit = (item: GridBookmarkItem) => {
    setEditingItem(item);
    setEditTitle(item.title || "");
    setEditNote(item.note || "");
    setEditCategory(item.category || "");
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;
    await onEditItem(editingItem.id, {
      title: editTitle,
      note: editNote,
      category: editCategory || undefined,
    });
    setEditingItem(null);
  };

  const openPendingQueue = async () => {
    setShowPending(true);
    const res = await window.bookmarkApi?.meta.pending(30);
    setPendingItems(res?.items || []);
  };

  // Group related items by primary signal for the Related View
  const relatedGroups = useMemo(() => {
    if (!relatedView) return [];
    const groups = new Map<string, RelatedCandidateItem[]>();
    for (const r of relatedView.related) {
      const groupKey = resolveRelatedGroupLabel(r.signals?.[0], developerView);
      const arr = groups.get(groupKey) || [];
      arr.push(r);
      groups.set(groupKey, arr);
    }
    const entries = Array.from(groups.entries());
    if (!developerView) {
      for (const [, list] of entries) {
        list.sort(
          (a, b) =>
            (b.score ?? 0) - (a.score ?? 0) ||
            (b.decisionScore ?? 0) - (a.decisionScore ?? 0),
        );
      }
      entries.sort(([labelA], [labelB]) => {
        if (labelA === "精判高相关") return -1;
        if (labelB === "精判高相关") return 1;
        return 0;
      });
    }
    return entries;
  }, [relatedView, developerView]);

  const bySource = meta?.stats?.by_source || [];
  const totalAll = meta?.stats?.total_active_items ?? total;

  return (
    <section className="grid-pane">
      {/* Sync Progress Bar */}
      {syncProgress && (
        <div className={`sync-bar sync-${syncProgress.status}`}>
          <span>
            {syncProgress.status === "running" ? "🔄" : syncProgress.status === "done" ? "✅" : "⚠️"}{" "}
            {syncProgress.message}
          </span>
          {syncProgress.status === "running" && syncProgress.total > 0 && (
            <div className="sync-progress-track">
              <div
                className="sync-progress-fill"
                style={{
                  width: `${Math.min(100, Math.round((syncProgress.progress / syncProgress.total) * 100))}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Source Tabs */}
      <div className="source-tabs" role="tablist" aria-label="收藏来源">
        <button
          type="button"
          role="tab"
          aria-selected={sourceFilter === ""}
          className={`tab-btn ${sourceFilter === "" ? "active" : ""}`}
          onClick={() => {
            onCloseRelated();
            onChangeSource("");
          }}
        >
          <span>✨ 全部收藏</span>
          <span className="tab-count">{totalAll}</span>
        </button>
        {bySource.map((s) => {
          const info = SOURCE_INFO[s.source] || { label: s.source, icon: "📌", cls: "source-manual" };
          return (
            <button
              key={s.source}
              type="button"
              role="tab"
              aria-selected={sourceFilter === s.source}
              className={`tab-btn ${sourceFilter === s.source ? "active" : ""}`}
              onClick={() => {
                onCloseRelated();
                onChangeSource(s.source);
              }}
            >
              <span>
                {info.icon} {info.label}
              </span>
              <span className="tab-count">{s.count}</span>
            </button>
          );
        })}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button
            type="button"
            className="ghost"
            onClick={openPendingQueue}
            title="查看低置信度待确认分类"
          >
            待确认队列
          </button>
        </div>
      </div>

      {/* Category Filter Pills */}
      <div className="category-bar" aria-label="分类筛选">
        <button
          type="button"
          className={`cat-pill ${categoryFilter === "" ? "active" : ""}`}
          onClick={() => {
            onCloseRelated();
            onChangeCategory("");
          }}
        >
          全部分类 ({totalAll})
        </button>
        {(meta?.categories || []).map((c: CategoryInfo) => (
          <button
            key={c.id}
            type="button"
            className={`cat-pill ${categoryFilter === c.id ? "active" : ""}`}
            onClick={() => {
              onCloseRelated();
              onChangeCategory(c.id);
            }}
          >
            {c.name} ({categoryCountMap[c.id] || 0})
          </button>
        ))}
        {(categoryCountMap.uncategorized || 0) > 0 && (
          <button
            type="button"
            className={`cat-pill ${categoryFilter === "uncategorized" ? "active" : ""}`}
            onClick={() => {
              onCloseRelated();
              onChangeCategory("uncategorized");
            }}
          >
            未分类 ({categoryCountMap.uncategorized})
          </button>
        )}
      </div>

      {/* Toolbar */}
      <div className="grid-toolbar">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => {
            onCloseRelated();
            onChangeQuery(e.target.value);
          }}
          placeholder="搜索标题、正文、作者（支持中英文）..."
        />
        <select
          value={mediaTypeFilter}
          onChange={(e) => {
            onCloseRelated();
            onChangeMediaType(e.target.value);
          }}
          aria-label="媒体类型"
        >
          <option value="">全部类型</option>
          <option value="post">图文 / 帖子</option>
          <option value="video">视频</option>
          <option value="article">长文</option>
          <option value="link">外链</option>
        </select>
        <select
          value={sortOrder}
          onChange={(e) => {
            onCloseRelated();
            onChangeSort(e.target.value as any);
          }}
          aria-label="排序方式"
        >
          <option value="first_seen_desc">最新收藏</option>
          <option value="first_seen_asc">最早收藏</option>
          <option value="publish_desc">最新发布</option>
          <option value="publish_asc">最早发布</option>
        </select>
        <span className="muted-sm">
          {relatedLoading
            ? "计算相关..."
            : relatedView
              ? `相关 ${relatedView.related.length} 条`
              : `已加载 ${items.length} / ${total} 条`}
        </span>
      </div>

      {/* Related View Mode */}
      {relatedView ? (
        <div className="related-view-container">
          <div className="related-banner visible">
            <div>
              <strong style={{ fontSize: "var(--fs-md)", color: "var(--accent)" }}>
                相关收藏
              </strong>
              {developerView && (
                <div className="muted-sm">
                  模式: {relatedView.mode} · 耗时 {relatedView.elapsedMs}ms · 按 signals 分组
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  const bundle: GridBookmarkItem[] = [];
                  if (relatedView.target) bundle.push(relatedView.target);
                  for (const r of relatedView.related.slice(0, 5)) {
                    bundle.push({
                      id: r.id,
                      source: r.source,
                      source_item_id: r.id,
                      url: r.url,
                      title: r.title,
                      excerpt: r.excerpt,
                      note: null,
                      author: r.author,
                      cover_url: r.cover_url,
                      media_type: r.media_type,
                      publish_date: null,
                      first_seen_at: "",
                      category: r.category,
                    });
                  }
                  onAskAgent(bundle, "请分析这组跨平台相关收藏之间的共同主题与互补联系");
                }}
              >
                在聊天中探索
              </button>
              <button type="button" className="secondary" onClick={onCloseRelated}>
                返回全部收藏
              </button>
            </div>
          </div>

          <div className="related-scroll">
            {relatedView.target && (() => {
              const targetImgSrc = coverProxyUrl(relatedView.target.cover_url);
              return (
                <div className="grid-item target-pinned">
                  {targetImgSrc && (
                    <div className="target-pinned-cover-wrap">
                      <img
                        className="grid-item-cover"
                        src={targetImgSrc}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          const wrap = e.currentTarget.parentElement;
                          if (wrap) wrap.style.display = "none";
                        }}
                      />
                    </div>
                  )}
                  <div className="target-pinned-content">
                    <div className="grid-item-top">
                      <span className="pill-row">
                        <span className="meta-pill">🎯 目标收藏</span>
                        <span
                          className={`source-badge ${SOURCE_INFO[relatedView.target.source]?.cls || "source-manual"}`}
                          title={SOURCE_INFO[relatedView.target.source]?.label || relatedView.target.source}
                          aria-label={SOURCE_INFO[relatedView.target.source]?.label || relatedView.target.source}
                        >
                          {SOURCE_INFO[relatedView.target.source]?.icon || "📌"}
                        </span>
                        <span>{relatedView.target.author || "未知作者"}</span>
                      </span>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => onOpenExternal(relatedView.target!.url)}
                      >
                        原帖 ↗
                      </button>
                    </div>
                    <div className="grid-item-title">
                      {relatedView.target.title || "(无标题收藏)"}
                    </div>
                    <div className="grid-item-excerpt">{relatedView.target.excerpt}</div>
                  </div>
                </div>
              );
            })()}

            {relatedGroups.map(([signalLabel, groupItems]) => (
              <div key={signalLabel} className="signal-group">
                <div className="signal-group-header">
                  <span className="signal-pill">{signalLabel}</span>
                  <span className="muted-sm">{groupItems.length} 条</span>
                </div>
                <div className="signal-group-grid">
                  {groupItems.map((rel) => {
                    const sInfo = SOURCE_INFO[rel.source] || {
                      label: rel.source,
                      icon: "📌",
                      cls: "source-manual",
                    };
                    const imgSrc = coverProxyUrl(rel.cover_url);
                    const visibleSignals = developerView
                      ? rel.signals
                      : rel.signals.filter(
                          (sig) => !HIGH_PRECISION_RE.test(sig) && !SEMANTIC_SIMILAR_RE.test(sig),
                        );
                    return (
                      <article key={rel.id} className={`grid-item ${imgSrc ? "" : "no-cover"}`}>
                        {imgSrc && (
                          <div className="grid-item-cover-wrap">
                            <img
                              className="grid-item-cover"
                              src={imgSrc}
                              alt=""
                              loading="lazy"
                              onError={(e) => {
                                const wrap = e.currentTarget.parentElement;
                                if (wrap) wrap.style.display = "none";
                              }}
                            />
                          </div>
                        )}
                        <div className="grid-item-body">
                          <div className="grid-item-top">
                            <span className="pill-row">
                              <span
                                className={`source-badge ${sInfo.cls}`}
                                title={sInfo.label}
                                aria-label={sInfo.label}
                              >
                                {sInfo.icon}
                              </span>
                              <span className="grid-item-author">{rel.author || "未知作者"}</span>
                            </span>
                            <span className="signal-pill">{Math.round(rel.score * 100)}%</span>
                          </div>
                          <div className="grid-item-title">{rel.title || "(无标题)"}</div>
                          <div className="grid-item-excerpt">{rel.excerpt?.slice(0, 180)}</div>
                          {visibleSignals.length > 0 && (
                            <div className="pill-row">
                              {visibleSignals.map((sig) => (
                                <span key={sig} className="signal-pill">
                                  {sig}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="grid-item-footer">
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => onOpenRelated(rel.id)}
                            >
                              以此为目标
                            </button>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button
                                type="button"
                                className="ghost"
                                onClick={() => onOpenExternal(rel.url)}
                              >
                                原帖 ↗
                              </button>
                              <button
                                type="button"
                                className="ghost danger-ghost"
                                onClick={() => onDismissRelated(relatedView.targetId, rel.id)}
                              >
                                不相关
                              </button>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Virtualized Multi-Source Grid */
        <div ref={scrollRef} className="virtual-scroll-viewport" onScroll={handleScroll}>
          {items.length === 0 && !loading ? (
            <div className="empty-state">当前筛选条件下没有收藏条目。</div>
          ) : (
            <div
              className="virtual-spacer"
              style={{ height: totalRows * rowHeight + 40, position: "relative" }}
            >
              <div
                className="virtual-window"
                style={{
                  position: "absolute",
                  top: startRow * rowHeight,
                  left: 0,
                  right: 0,
                  display: "grid",
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  gap: GRID_GAP,
                  padding: "12px 14px",
                }}
              >
                {visibleSlice.slice.map((item) => {
                  const sInfo = SOURCE_INFO[item.source] || {
                    label: item.source,
                    icon: "📌",
                    cls: "source-manual",
                  };
                  const imgSrc = coverProxyUrl(item.cover_url);
                  const isHighlighted = highlightedId === item.id;
                  const isSelected = selectedMap.has(item.id);
                  const catName = item.category
                    ? categoryNameMap[item.category] || item.category
                    : "未分类";

                  return (
                    <article
                      key={item.id}
                      className={`grid-item virtual-card ${imgSrc ? "" : "no-cover"} ${isHighlighted ? "highlighted" : ""} ${isSelected ? "selected" : ""}`}
                      style={{ height: cardHeight }}
                      aria-selected={isSelected}
                      onClick={() => {
                        if (contextMenu) return;
                        toggleSelect(item);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({
                          x: Math.min(e.clientX, window.innerWidth - 210),
                          y: Math.min(e.clientY, window.innerHeight - 220),
                          item,
                        });
                      }}
                    >
                      {imgSrc && (
                        <div className="grid-item-cover-wrap">
                          <img
                            className="grid-item-cover"
                            src={imgSrc}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              const wrap = e.currentTarget.parentElement;
                              if (wrap) wrap.style.display = "none";
                            }}
                          />
                        </div>
                      )}
                      <div className="grid-item-body">
                        <div className="grid-item-top">
                          <div className="card-check-label">
                            <span
                              className={`source-badge ${sInfo.cls}`}
                              title={sInfo.label}
                              aria-label={sInfo.label}
                            >
                              {sInfo.icon}
                            </span>
                            <span className="grid-item-author" title={item.author || ""}>
                              {item.author || "未知作者"}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenExternal(item.url);
                            }}
                          >
                            原帖 ↗
                          </button>
                        </div>
                        <div className="grid-item-title">{item.title || "(无标题收藏)"}</div>
                        <div className="grid-item-excerpt">
                          {(item.excerpt || "").slice(0, imgSrc ? 180 : 420)}
                        </div>
                        <div className="pill-row">
                          <span className="meta-pill">{catName}</span>
                          <span className="meta-pill">
                            {MEDIA_LABELS[item.media_type || "post"] || item.media_type}
                          </span>
                        </div>
                        <div className="grid-item-footer">
                          {developerView && <code className="item-id-code">{item.id}</code>}
                          <button
                            type="button"
                            className="ghost"
                            style={developerView ? undefined : { marginLeft: "auto" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenRelated(item.id);
                            }}
                          >
                            相关收藏
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
          {loading && <div className="loading-more">正在加载更多收藏...</div>}
        </div>
      )}

      {/* Multi-select floating bar */}
      {selectedMap.size > 0 && (
        <div className="selection-float-bar">
          <span>已选择 {selectedMap.size} 条收藏</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                onAskAgent(Array.from(selectedMap.values()));
                setSelectedMap(new Map());
              }}
            >
              💬 问问 Agent
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setSelectedMap(new Map())}
            >
              清空选择
            </button>
          </div>
        </div>
      )}

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenRelated(contextMenu.item.id);
              setContextMenu(null);
            }}
          >
            🔗 查看相关收藏
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAskAgent([contextMenu.item]);
              setContextMenu(null);
            }}
          >
            💬 问问 Agent
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openEdit(contextMenu.item);
              setContextMenu(null);
            }}
          >
            ✏️ 编辑标题 / 备注 / 分类
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenExternal(contextMenu.item.url);
              setContextMenu(null);
            }}
          >
            🌐 在浏览器中打开原帖
          </button>
          <hr className="menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="danger-item"
            onClick={() => {
              void onDeleteItem(contextMenu.item.id);
              setContextMenu(null);
            }}
          >
            🗑️ 删除收藏（本地软删除）
          </button>
        </div>
      )}

      {/* Edit Item Modal */}
      {editingItem && (
        <div className="modal-backdrop" onClick={() => setEditingItem(null)}>
          <form
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleSaveEdit}
          >
            <h3>编辑收藏{developerView ? ` (${editingItem.id})` : ""}</h3>
            <label className="field-label">
              标题
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </label>
            <label className="field-label">
              分类
              <select
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value)}
              >
                <option value="">保持不变</option>
                {(meta?.categories || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              个人备注
              <textarea
                rows={3}
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setEditingItem(null)}>
                取消
              </button>
              <button type="submit">保存修改</button>
            </div>
          </form>
        </div>
      )}

      {/* Pending Category Confirmation Queue Modal */}
      {showPending && (
        <div className="modal-backdrop" onClick={() => setShowPending(false)}>
          <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-row">
              <h3>待确认分类队列（主动学习）</h3>
              <button type="button" className="ghost" onClick={() => setShowPending(false)}>
                关闭
              </button>
            </div>
            {pendingItems.length === 0 ? (
              <p className="muted-sm">当前没有待确认的低置信度条目。</p>
            ) : (
              <div className="pending-list">
                {pendingItems.map((p) => (
                  <div key={p.id} className="pending-row">
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "var(--fs-md)" }}>
                        {p.title || p.author || p.id}
                      </div>
                      <div className="muted-sm">{p.excerpt}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {(meta?.categories || []).map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className={c.id === p.suggestedCategoryId ? "" : "ghost"}
                          onClick={async () => {
                            await onConfirmPending(p.id, c.id);
                            setPendingItems((prev) => prev.filter((x) => x.id !== p.id));
                          }}
                        >
                          {c.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
