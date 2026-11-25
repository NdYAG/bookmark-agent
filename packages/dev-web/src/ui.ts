export function renderDevWebHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bookmark Agent · Dev-Web (多平台社媒收藏 + A2UI 联动)</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f172a;
      --bg-deep: #0b1120;
      --panel: #1e293b;
      --panel-hover: #26354d;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.28);
      --highlight: #f59e0b;
      --highlight-bg: rgba(245, 158, 11, 0.16);
      --x-badge-bg: rgba(56, 189, 248, 0.14);
      --x-badge-fg: #7dd3fc;
      --xhs-badge-bg: rgba(244, 63, 94, 0.16);
      --xhs-badge-fg: #fda4af;
      --manual-badge-bg: rgba(52, 211, 153, 0.16);
      --manual-badge-fg: #6ee7b7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      padding: 10px 18px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--bg-deep);
      gap: 12px;
      flex-shrink: 0;
    }
    header h1 {
      font-size: 15px;
      margin: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      white-space: nowrap;
    }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.35);
      font-weight: 500;
    }
    .source-badge {
      font-size: 10.5px;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 600;
      letter-spacing: 0.02em;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .source-badge.source-x {
      background: var(--x-badge-bg);
      color: var(--x-badge-fg);
      border: 1px solid rgba(56, 189, 248, 0.28);
    }
    .source-badge.source-xhs {
      background: var(--xhs-badge-bg);
      color: var(--xhs-badge-fg);
      border: 1px solid rgba(244, 63, 94, 0.32);
    }
    .source-badge.source-manual {
      background: var(--manual-badge-bg);
      color: var(--manual-badge-fg);
      border: 1px solid rgba(52, 211, 153, 0.32);
    }
    .main-split {
      flex: 1;
      display: grid;
      grid-template-columns: 42% 58%;
      overflow: hidden;
    }
    /* Left: Chat + A2UI Surface Renderer */
    .chat-pane {
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .msg {
      padding: 12px 14px;
      border-radius: 10px;
      line-height: 1.55;
      font-size: 13.5px;
      max-width: 96%;
    }
    .msg.user {
      align-self: flex-end;
      background: #1d4ed8;
      color: #fff;
    }
    .msg.assistant {
      align-self: flex-start;
      background: var(--panel);
      border: 1px solid var(--border);
      width: 96%;
    }
    .msg-text {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .tool-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .tool-pill {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--bg);
      color: var(--muted);
      border: 1px solid var(--border);
    }
    /* A2UI Surface Components */
    .a2ui-surface {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px dashed var(--border);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .a2ui-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      transition: border-color 0.16s ease, box-shadow 0.16s ease;
    }
    .a2ui-card:hover {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-glow);
    }
    .a2ui-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11.5px;
      color: var(--accent);
      margin-bottom: 4px;
      gap: 8px;
    }
    .a2ui-card-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .a2ui-card-excerpt {
      font-size: 12px;
      color: var(--muted);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .a2ui-card-highlight {
      margin-top: 6px;
      font-size: 11.5px;
      color: #fcd34d;
      background: rgba(245, 158, 11, 0.12);
      padding: 4px 8px;
      border-radius: 4px;
    }
    .a2ui-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 8px;
    }
    .a2ui-compare {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
    }
    .a2ui-compare-col {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
    }
    .attached-bar {
      padding: 6px 14px;
      background: rgba(56, 189, 248, 0.1);
      border-top: 1px solid var(--border);
      font-size: 12px;
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .chat-input-bar {
      padding: 12px 14px;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 8px;
      background: var(--bg-deep);
    }
    .chat-input-bar input {
      flex: 1;
      background: var(--panel);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 9px 12px;
      border-radius: 6px;
      font-size: 13.5px;
    }
    button {
      background: var(--accent);
      color: #0f172a;
      border: none;
      font-weight: 600;
      padding: 7px 13px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12.5px;
      transition: opacity 0.15s ease, border-color 0.15s ease;
    }
    button:hover:not(:disabled) {
      opacity: 0.92;
    }
    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    button.secondary {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
    }
    button.ghost {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 500;
    }
    button.ghost:hover {
      color: var(--accent);
      border-color: var(--accent);
    }

    /* Right: Multi-Platform Social Bookmark Grid */
    .grid-pane {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .source-tabs {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 14px 8px;
      background: var(--bg-deep);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .tab-btn {
      background: var(--panel);
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 5px 11px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .tab-btn.active {
      background: rgba(56, 189, 248, 0.16);
      color: var(--text);
      border-color: var(--accent);
    }
    .tab-count {
      font-size: 11px;
      color: var(--muted);
      background: rgba(15, 23, 42, 0.6);
      padding: 0 6px;
      border-radius: 999px;
    }
    .tab-btn.active .tab-count {
      color: var(--accent);
    }
    .category-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
      flex-shrink: 0;
    }
    .cat-pill {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 3px 9px;
      border-radius: 6px;
      font-size: 11.5px;
      font-weight: 500;
      white-space: nowrap;
    }
    .cat-pill.active {
      background: var(--panel-hover);
      color: var(--accent);
      border-color: var(--accent);
    }
    .grid-toolbar {
      padding: 9px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    .grid-toolbar input {
      flex: 1;
      min-width: 160px;
      background: var(--panel);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 7px 10px;
      border-radius: 6px;
      font-size: 12.5px;
    }
    .grid-toolbar select {
      background: var(--panel);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 7px 8px;
      border-radius: 6px;
      font-size: 12px;
    }
    .related-banner {
      display: none;
      padding: 10px 14px;
      background: rgba(56, 189, 248, 0.08);
      border-bottom: 1px solid rgba(56, 189, 248, 0.35);
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-shrink: 0;
    }
    .related-banner.visible {
      display: flex;
    }
    .grid-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
      gap: 10px;
      align-content: start;
    }
    .grid-item {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
      display: flex;
      flex-direction: column;
      gap: 7px;
      content-visibility: auto;
      contain-intrinsic-size: 210px;
    }
    .grid-item:hover {
      border-color: #475569;
    }
    .grid-item.highlighted {
      border-color: var(--highlight);
      background: var(--highlight-bg);
      box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.4);
    }
    .grid-item.target-pinned {
      grid-column: 1 / -1;
      border-color: var(--accent);
      background: rgba(56, 189, 248, 0.09);
    }
    .grid-item-cover {
      width: 100%;
      aspect-ratio: 16 / 10;
      object-fit: cover;
      border-radius: 6px;
      background: var(--bg-deep);
      display: block;
    }
    .grid-item-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11.5px;
      color: var(--muted);
      gap: 6px;
    }
    .grid-item-author {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 160px;
    }
    .grid-item-title {
      font-weight: 600;
      font-size: 13px;
      color: var(--text);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .grid-item-excerpt {
      font-size: 12px;
      color: #cbd5e1;
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .grid-item-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
      font-size: 11px;
      color: var(--muted);
    }
    .meta-pill {
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid var(--border);
      color: var(--muted);
    }
    .signal-pill {
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.35);
      color: #fcd34d;
    }
    .grid-item-footer {
      margin-top: auto;
      padding-top: 6px;
      border-top: 1px solid rgba(51, 65, 85, 0.6);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 11.5px;
    }
    .grid-pagination {
      padding: 9px 14px;
      border-top: 1px solid var(--border);
      background: var(--bg-deep);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .empty-state {
      grid-column: 1 / -1;
      text-align: center;
      padding: 40px 16px;
      color: var(--muted);
      font-size: 13.5px;
    }
  </style>
</head>
<body>
  <header>
    <h1>
      <span>Bookmark Agent · Dev-Web</span>
      <span class="badge" id="totalStatsBadge">多平台社媒收藏 · 加载中</span>
    </h1>
    <div style="display:flex; gap:10px; align-items:center; font-size:12px;">
      <label style="cursor:pointer; display:inline-flex; align-items:center; gap:4px;">
        <input type="checkbox" id="allowWritesToggle" /> 允许写操作
      </label>
      <button class="secondary" id="attachSelectedBtn">将勾选条目附到对话 (0)</button>
    </div>
  </header>

  <div class="main-split">
    <section class="chat-pane">
      <div class="chat-messages" id="chatMessages">
        <div class="msg assistant">
          <div class="msg-text">你好！我是你的个人收藏管理 Agent，目前已接入你在 X 与小红书的全部社媒收藏。你可以跨平台搜索、对比主题、深挖某条收藏，或在右侧勾选条目 / 点击「相关收藏」一起探讨。点击回答中的 A2UI 卡片可在右侧高亮定位。</div>
        </div>
      </div>
      <div class="attached-bar" id="attachedBar">
        <span id="attachedBarText">已附加 0 条收藏</span>
        <button class="secondary" id="clearAttachedBtn" style="padding:2px 8px; font-size:11px;">清除</button>
      </div>
      <form class="chat-input-bar" id="chatForm">
        <input type="text" id="chatInput" placeholder="输入问题（例如：我在小红书和 X 上收藏过哪些动效设计案例？）..." autocomplete="off" />
        <button type="submit" id="sendBtn">发送</button>
      </form>
    </section>

    <section class="grid-pane">
      <div class="source-tabs" id="sourceTabs" role="tablist" aria-label="收藏来源筛选"></div>
      <div class="category-bar" id="categoryBar" aria-label="分类筛选"></div>
      <div class="grid-toolbar">
        <input type="text" id="gridSearchInput" placeholder="搜索标题、正文、作者（支持中英文）..." />
        <select id="mediaTypeSelect" aria-label="媒体类型">
          <option value="">全部类型</option>
          <option value="post">图文 / 帖子</option>
          <option value="video">视频</option>
          <option value="article">长文</option>
          <option value="link">外链</option>
        </select>
        <select id="sortSelect" aria-label="排序方式">
          <option value="first_seen_desc">最新收藏</option>
          <option value="first_seen_asc">最早收藏</option>
          <option value="publish_desc">最新发布</option>
          <option value="publish_asc">最早发布</option>
        </select>
        <span id="gridCountLabel" style="font-size:12px; color:var(--muted); white-space:nowrap;">加载中...</span>
      </div>

      <div class="related-banner" id="relatedBanner">
        <div>
          <strong style="font-size:13px; color:var(--accent);" id="relatedBannerTitle">相关收藏视图</strong>
          <div style="font-size:11.5px; color:var(--muted);" id="relatedBannerSub"></div>
        </div>
        <div style="display:flex; gap:8px;">
          <button id="exploreRelatedInChatBtn">在聊天中探索</button>
          <button class="secondary" id="exitRelatedBtn">返回全部收藏</button>
        </div>
      </div>

      <div class="grid-list" id="gridList"></div>

      <div class="grid-pagination" id="gridPagination">
        <button class="secondary" id="prevPageBtn">上一页</button>
        <span id="pageInfoLabel">第 1 / 1 页</span>
        <button class="secondary" id="nextPageBtn">下一页</button>
      </div>
    </section>
  </div>

  <script>
    const SOURCE_META = {
      x: { label: "X", icon: "𝕏", cls: "source-x" },
      xhs: { label: "小红书", icon: "📕", cls: "source-xhs" },
      manual: { label: "手动", icon: "🔗", cls: "source-manual" },
    };

    const MEDIA_LABELS = {
      post: "帖子",
      video: "🎬 视频",
      article: "📄 长文",
      link: "🔗 外链",
    };

    let metaState = { stats: null, categories: [], categoryCounts: [], sources: [] };
    let categoryNameMap = {};
    let filterState = {
      source: "",
      category: "",
      mediaType: "",
      query: "",
      sort: "first_seen_desc",
      page: 1,
      pageSize: 36,
    };
    let pageState = { total: 0, totalPages: 1 };
    let allGridItems = [];
    let relatedView = null; // { target, related }
    let selectedItemsMap = new Map();
    let attachedItems = [];
    let activeHighlightedId = null;
    let searchTimer = null;

    const totalStatsBadge = document.getElementById("totalStatsBadge");
    const sourceTabsEl = document.getElementById("sourceTabs");
    const categoryBarEl = document.getElementById("categoryBar");
    const gridListEl = document.getElementById("gridList");
    const gridCountEl = document.getElementById("gridCountLabel");
    const gridPaginationEl = document.getElementById("gridPagination");
    const pageInfoLabel = document.getElementById("pageInfoLabel");
    const prevPageBtn = document.getElementById("prevPageBtn");
    const nextPageBtn = document.getElementById("nextPageBtn");
    const relatedBanner = document.getElementById("relatedBanner");
    const relatedBannerTitle = document.getElementById("relatedBannerTitle");
    const relatedBannerSub = document.getElementById("relatedBannerSub");
    const exploreRelatedInChatBtn = document.getElementById("exploreRelatedInChatBtn");
    const exitRelatedBtn = document.getElementById("exitRelatedBtn");

    const chatMessagesEl = document.getElementById("chatMessages");
    const chatForm = document.getElementById("chatForm");
    const chatInput = document.getElementById("chatInput");
    const attachSelectedBtn = document.getElementById("attachSelectedBtn");
    const attachedBar = document.getElementById("attachedBar");
    const attachedBarText = document.getElementById("attachedBarText");
    const clearAttachedBtn = document.getElementById("clearAttachedBtn");
    const allowWritesToggle = document.getElementById("allowWritesToggle");

    function getSourceBadgeHtml(source) {
      const info = SOURCE_META[source] || { label: source || "未知", icon: "📌", cls: "source-manual" };
      return \`<span class="source-badge \${info.cls}">\${info.icon} \${escapeHtml(info.label)}</span>\`;
    }

    async function loadMeta() {
      const res = await fetch("/api/meta");
      const data = await res.json();
      metaState = data;
      categoryNameMap = {};
      for (const c of (data.categories || [])) {
        categoryNameMap[c.id] = c.name || c.id;
      }

      const total = data.stats?.total_active_items ?? 0;
      const bySource = data.stats?.by_source || [];
      const sourceSummary = bySource
        .map((s) => \`\${(SOURCE_META[s.source]?.label || s.source)} \${s.count}\`)
        .join(" · ");
      totalStatsBadge.textContent = sourceSummary ? \`共 \${total} 条 (\${sourceSummary})\` : \`共 \${total} 条\`;

      renderSourceTabs(total, bySource);
      renderCategoryBar(data.categories || [], data.categoryCounts || []);
    }

    function renderSourceTabs(total, bySource) {
      const tabs = [{ id: "", label: "全部收藏", icon: "✨", count: total }];
      for (const s of bySource) {
        const info = SOURCE_META[s.source] || { label: s.source, icon: "📌" };
        tabs.push({ id: s.source, label: info.label, icon: info.icon, count: s.count });
      }
      sourceTabsEl.innerHTML = tabs
        .map((t) => \`
          <button
            type="button"
            role="tab"
            aria-selected="\${filterState.source === t.id}"
            class="tab-btn \${filterState.source === t.id ? "active" : ""}"
            data-source-tab="\${escapeHtml(t.id)}"
          >
            <span>\${t.icon} \${escapeHtml(t.label)}</span>
            <span class="tab-count">\${t.count}</span>
          </button>
        \`)
        .join("");

      sourceTabsEl.querySelectorAll("[data-source-tab]").forEach((btn) => {
        btn.addEventListener("click", () => {
          relatedView = null;
          filterState.source = btn.getAttribute("data-source-tab") || "";
          filterState.page = 1;
          renderSourceTabs(metaState.stats?.total_active_items ?? 0, metaState.stats?.by_source || []);
          loadGridItems();
        });
      });
    }

    function renderCategoryBar(categories, categoryCounts) {
      const countMap = {};
      for (const row of categoryCounts) {
        countMap[row.category] = row.count;
      }
      const pills = [{ id: "", name: "全部分类", count: metaState.stats?.total_active_items ?? 0 }];
      for (const c of categories) {
        pills.push({ id: c.id, name: c.name || c.id, count: countMap[c.id] || 0 });
      }
      if (countMap.uncategorized) {
        pills.push({ id: "uncategorized", name: "未分类", count: countMap.uncategorized });
      }

      categoryBarEl.innerHTML = pills
        .map((p) => \`
          <button
            type="button"
            class="cat-pill \${filterState.category === p.id ? "active" : ""}"
            data-cat-pill="\${escapeHtml(p.id)}"
          >\${escapeHtml(p.name)} (\${p.count})</button>
        \`)
        .join("");

      categoryBarEl.querySelectorAll("[data-cat-pill]").forEach((btn) => {
        btn.addEventListener("click", () => {
          relatedView = null;
          filterState.category = btn.getAttribute("data-cat-pill") || "";
          filterState.page = 1;
          renderCategoryBar(metaState.categories || [], metaState.categoryCounts || []);
          loadGridItems();
        });
      });
    }

    async function loadGridItems() {
      relatedBanner.classList.remove("visible");
      gridPaginationEl.style.display = "flex";

      const qs = new URLSearchParams({
        page: String(filterState.page),
        pageSize: String(filterState.pageSize),
        sort: filterState.sort,
      });
      if (filterState.source) qs.set("source", filterState.source);
      if (filterState.category) qs.set("category", filterState.category);
      if (filterState.mediaType) qs.set("mediaType", filterState.mediaType);
      if (filterState.query.trim()) qs.set("query", filterState.query.trim());

      const res = await fetch("/api/items?" + qs.toString());
      const data = await res.json();
      allGridItems = data.items || [];
      pageState.total = data.total ?? allGridItems.length;
      pageState.totalPages = Math.max(1, data.totalPages || 1);

      gridCountEl.textContent = \`共 \${pageState.total} 条\`;
      pageInfoLabel.textContent = \`第 \${filterState.page} / \${pageState.totalPages} 页（共 \${pageState.total} 条）\`;
      prevPageBtn.disabled = filterState.page <= 1;
      nextPageBtn.disabled = filterState.page >= pageState.totalPages;

      renderGrid(allGridItems);
    }

    async function openRelatedView(itemId) {
      gridCountEl.textContent = "计算相关收藏...";
      const res = await fetch("/api/related?id=" + encodeURIComponent(itemId) + "&k=12");
      const data = await res.json();
      if (!res.ok || data.error) {
        gridCountEl.textContent = "相关收藏加载失败";
        return;
      }
      relatedView = data;
      const targetTitle = data.target?.title || data.target?.author || itemId;
      relatedBannerTitle.textContent = \`🔗 相关收藏 · \${String(targetTitle).slice(0, 42)}\`;
      relatedBannerSub.textContent = \`模式: \${data.mode || "hybrid"} · 耗时 \${data.elapsedMs ?? "-"}ms · 召回 \${(data.related || []).length} 条跨平台相关收藏\`;
      relatedBanner.classList.add("visible");
      gridPaginationEl.style.display = "none";
      gridCountEl.textContent = \`相关 \${(data.related || []).length} 条\`;

      const combined = [];
      if (data.target) {
        combined.push({ ...data.target, _isTarget: true });
      }
      for (const rel of (data.related || [])) {
        combined.push({
          ...(rel.item || rel),
          _score: rel.score,
          _signals: rel.signals || [],
        });
      }
      renderGrid(combined);
    }

    function renderGrid(items) {
      gridListEl.innerHTML = "";
      if (!items.length) {
        gridListEl.innerHTML = '<div class="empty-state">当前筛选条件下没有收藏条目。</div>';
        return;
      }

      for (const item of items) {
        const div = document.createElement("article");
        div.className =
          "grid-item" +
          (activeHighlightedId === item.id ? " highlighted" : "") +
          (item._isTarget ? " target-pinned" : "");
        div.dataset.itemId = item.id;

        const checked = selectedItemsMap.has(item.id) ? "checked" : "";
        const catLabel = item.category ? (categoryNameMap[item.category] || item.category) : "未分类";
        const mediaLabel = MEDIA_LABELS[item.media_type] || item.media_type || "帖子";
        const coverHtml = item.cover_url
          ? \`<img class="grid-item-cover" src="\${escapeHtml(item.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'" />\`
          : "";
        const signalsHtml = Array.isArray(item._signals) && item._signals.length
          ? item._signals.map((s) => \`<span class="signal-pill">\${escapeHtml(s)}</span>\`).join("")
          : "";
        const scoreHtml = typeof item._score === "number"
          ? \`<span class="signal-pill">相关度 \${(item._score * 100).toFixed(0)}%</span>\`
          : "";

        div.innerHTML = \`
          \${coverHtml}
          <div class="grid-item-top">
            <label style="cursor:pointer; display:flex; align-items:center; gap:6px; min-width:0;">
              <input type="checkbox" data-select-id="\${escapeHtml(item.id)}" \${checked} />
              \${getSourceBadgeHtml(item.source)}
              <span class="grid-item-author" title="\${escapeHtml(item.author || "未知作者")}">\${escapeHtml(item.author || "未知作者")}</span>
            </label>
            <a href="\${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--muted); text-decoration:none; white-space:nowrap;">原帖 ↗</a>
          </div>
          <div class="grid-item-title">\${item._isTarget ? "🎯 [目标收藏] " : ""}\${escapeHtml(item.title || "(无标题收藏)")}</div>
          <div class="grid-item-excerpt">\${escapeHtml((item.excerpt || "").slice(0, 220))}</div>
          <div class="grid-item-meta">
            <span class="meta-pill">\${escapeHtml(catLabel)}</span>
            <span class="meta-pill">\${escapeHtml(mediaLabel)}</span>
            \${scoreHtml}
            \${signalsHtml}
          </div>
          <div class="grid-item-footer">
            <code style="color:var(--muted); font-size:10.5px; overflow:hidden; text-overflow:ellipsis;">\${escapeHtml(item.id)}</code>
            <button type="button" class="ghost" data-related-id="\${escapeHtml(item.id)}">相关收藏</button>
          </div>
        \`;
        gridListEl.appendChild(div);
      }

      gridListEl.querySelectorAll("input[data-select-id]").forEach((cb) => {
        cb.addEventListener("change", (e) => {
          const id = e.target.getAttribute("data-select-id");
          const item = items.find((it) => it.id === id);
          if (e.target.checked && item) selectedItemsMap.set(id, item);
          else selectedItemsMap.delete(id);
          attachSelectedBtn.textContent = \`将勾选条目附到对话 (\${selectedItemsMap.size})\`;
        });
      });

      gridListEl.querySelectorAll("button[data-related-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-related-id");
          if (id) openRelatedView(id);
        });
      });
    }

    // Card click in A2UI Surface -> Highlight & scroll in Right Grid!
    window.highlightBookmarkInGrid = function(itemId) {
      activeHighlightedId = itemId;
      let found = false;
      document.querySelectorAll(".grid-item").forEach((el) => {
        if (el.dataset.itemId === itemId) {
          el.classList.add("highlighted");
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          found = true;
        } else {
          el.classList.remove("highlighted");
        }
      });
      if (!found && itemId) {
        // If card is not on current page, open its Related View to inspect it immediately
        openRelatedView(itemId);
      }
    };

    attachSelectedBtn.addEventListener("click", () => {
      if (selectedItemsMap.size === 0) return;
      attachedItems = Array.from(selectedItemsMap.values());
      attachedBar.style.display = "flex";
      attachedBarText.textContent = "已附加 " + attachedItems.length + " 条收藏: " + attachedItems.map((i) => i.id).join(", ");
    });

    exploreRelatedInChatBtn.addEventListener("click", () => {
      if (!relatedView) return;
      const items = [];
      if (relatedView.target) items.push(relatedView.target);
      for (const rel of (relatedView.related || []).slice(0, 5)) {
        if (rel.item) items.push(rel.item);
      }
      if (!items.length) return;
      attachedItems = items;
      attachedBar.style.display = "flex";
      attachedBarText.textContent = "已附加相关收藏组 (" + attachedItems.length + " 条): " + attachedItems.map((i) => i.id).join(", ");
      chatInput.value = "请分析这组相关收藏之间的共同主题与联系";
      chatInput.focus();
    });

    exitRelatedBtn.addEventListener("click", () => {
      relatedView = null;
      loadGridItems();
    });

    clearAttachedBtn.addEventListener("click", () => {
      attachedItems = [];
      attachedBar.style.display = "none";
    });

    document.getElementById("gridSearchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        relatedView = null;
        filterState.query = e.target.value;
        filterState.page = 1;
        loadGridItems();
      }, 220);
    });

    document.getElementById("mediaTypeSelect").addEventListener("change", (e) => {
      relatedView = null;
      filterState.mediaType = e.target.value;
      filterState.page = 1;
      loadGridItems();
    });

    document.getElementById("sortSelect").addEventListener("change", (e) => {
      relatedView = null;
      filterState.sort = e.target.value;
      filterState.page = 1;
      loadGridItems();
    });

    prevPageBtn.addEventListener("click", () => {
      if (filterState.page > 1) {
        filterState.page -= 1;
        loadGridItems();
      }
    });

    nextPageBtn.addEventListener("click", () => {
      if (filterState.page < pageState.totalPages) {
        filterState.page += 1;
        loadGridItems();
      }
    });

    function renderA2uiCard(item, highlight) {
      if (!item) return "";
      const title = item.title || item.author || item.id;
      const excerpt = (item.enriched_card && item.enriched_card.summary) || item.excerpt || "";
      const source = item.source || (String(item.id || "").startsWith("xhs:") ? "xhs" : "x");
      return \`
        <div class="a2ui-card" data-a2ui-item-id="\${escapeHtml(item.id)}" onclick="window.highlightBookmarkInGrid('\${escapeHtml(item.id)}')">
          <div class="a2ui-card-header">
            <span style="display:inline-flex; align-items:center; gap:6px;">\${getSourceBadgeHtml(source)} \${escapeHtml(item.author || item.id)}</span>
            <code>\${escapeHtml(item.id)}</code>
          </div>
          <div class="a2ui-card-title">\${escapeHtml(title)}</div>
          <div class="a2ui-card-excerpt">\${escapeHtml(excerpt)}</div>
          \${highlight ? \`<div class="a2ui-card-highlight">💡 \${escapeHtml(highlight)}</div>\` : ""}
        </div>
      \`;
    }

    function renderA2uiSurface(surface) {
      const container = document.createElement("div");
      container.className = "a2ui-surface";
      let html = "";
      for (const node of (surface.components || [])) {
        const p = node.props || {};
        if (node.component === "CollectionCard") {
          html += renderA2uiCard(p.item || { id: p.id, title: p.id }, p.highlight);
        } else if (node.component === "ItemGrid") {
          if (p.title) html += \`<div style="font-weight:600;font-size:13px;">\${escapeHtml(p.title)}</div>\`;
          html += \`<div class="a2ui-grid">\`;
          for (const it of (p.items || [])) {
            const note = p.notes && p.notes[it.id];
            html += renderA2uiCard(it, note);
          }
          html += \`</div>\`;
        } else if (node.component === "ThemeCompare") {
          html += \`<div style="font-weight:600;font-size:13px;">⚖️ \${escapeHtml(p.title || "主题对比")}</div>\`;
          html += \`<div class="a2ui-compare">\`;
          for (const col of (p.columns || [])) {
            html += \`
              <div class="a2ui-compare-col">
                <div style="font-weight:600;color:var(--accent);margin-bottom:4px;">\${escapeHtml(col.theme)}</div>
                <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">\${escapeHtml(col.summary)}</div>
                \${(col.items || []).map((it) => renderA2uiCard(it)).join("")}
              </div>
            \`;
          }
          html += \`</div>\`;
        } else if (node.component === "Timeline") {
          html += \`<div style="font-weight:600;font-size:13px;">🕒 \${escapeHtml(p.title || "时间线")}</div>\`;
          for (const step of (p.steps || [])) {
            html += \`
              <div class="a2ui-compare-col">
                <div style="font-weight:600;color:var(--accent);">\${escapeHtml(step.label)} \${step.date ? \`(\${escapeHtml(step.date)})\` : ""}</div>
                <div style="font-size:12px;color:var(--muted);margin:4px 0 8px;">\${escapeHtml(step.takeaway)}</div>
                \${(step.items || []).map((it) => renderA2uiCard(it)).join("")}
              </div>
            \`;
          }
        }
      }
      container.innerHTML = html;
      return container;
    }

    chatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text && attachedItems.length === 0) return;

      const userDiv = document.createElement("div");
      userDiv.className = "msg user";
      userDiv.textContent = (attachedItems.length ? \`[附带 \${attachedItems.length} 条收藏] \` : "") + text;
      chatMessagesEl.appendChild(userDiv);

      const payload = attachedItems.length > 0
        ? {
            sessionId: "dev-web-default",
            type: "attached_items",
            items: attachedItems,
            prompt: text,
            allowWrites: allowWritesToggle.checked,
          }
        : {
            sessionId: "dev-web-default",
            type: "text",
            text,
            allowWrites: allowWritesToggle.checked,
          };

      chatInput.value = "";
      attachedItems = [];
      attachedBar.style.display = "none";

      const assistantDiv = document.createElement("div");
      assistantDiv.className = "msg assistant";
      const toolsDiv = document.createElement("div");
      toolsDiv.className = "tool-pills";
      const textDiv = document.createElement("div");
      textDiv.className = "msg-text";
      textDiv.textContent = "思考中...";
      assistantDiv.appendChild(toolsDiv);
      assistantDiv.appendChild(textDiv);
      chatMessagesEl.appendChild(assistantDiv);
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

      let streamedText = "";
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\\n\\n");
        buf = parts.pop() || "";

        for (const chunk of parts) {
          const lines = chunk.split("\\n");
          let evType = "message";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) evType = line.slice(7).trim();
            if (line.startsWith("data: ")) dataStr = line.slice(6);
          }
          if (!dataStr) continue;
          const ev = JSON.parse(dataStr);

          if (evType === "tool_call_start") {
            const pill = document.createElement("span");
            pill.className = "tool-pill";
            pill.textContent = "🔧 " + ev.name + "(" + JSON.stringify(ev.args) + ")";
            toolsDiv.appendChild(pill);
          } else if (evType === "text_delta") {
            streamedText += ev.delta;
            textDiv.textContent = streamedText;
          } else if (evType === "surface_ready") {
            assistantDiv.appendChild(renderA2uiSurface(ev.surface));
          } else if (evType === "turn_complete") {
            // Drop A2UI surface position markers; dev-web appends surfaces below the text
            textDiv.textContent = (ev.message.text || streamedText).replace(/\\x3c!--a2ui:\\d+-->/g, "").replace(/\\n{3,}/g, "\\n\\n");
          } else if (evType === "error") {
            textDiv.textContent = "错误: " + ev.message;
          }
          chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        }
      }
    });

    function escapeHtml(str) {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    Promise.all([loadMeta(), loadGridItems()]);
  </script>
</body>
</html>`;
}
