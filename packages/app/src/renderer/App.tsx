import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentMessage,
  GridBookmarkItem,
  MetaResponse,
  RelatedResponse,
  SearchMessageHit,
  SessionRecord,
  SyncProgressEvent,
} from "../shared/types";
import { BookmarkGrid } from "./components/BookmarkGrid";
import { ChatPane, type StreamingDraft } from "./components/ChatPane";
import { OnboardingModal } from "./components/OnboardingModal";
import { SettingsModal } from "./components/SettingsModal";

export const App: React.FC = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [items, setItems] = useState<GridBookmarkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);

  const [sourceFilter, setSourceFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [mediaTypeFilter, setMediaTypeFilter] = useState("");
  const [sortOrder, setSortOrder] = useState<
    "first_seen_desc" | "first_seen_asc" | "publish_desc" | "publish_asc"
  >("first_seen_desc");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [relatedView, setRelatedView] = useState<RelatedResponse | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgressEvent | null>(null);

  // Chat state
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("default");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingDraft | null>(null);
  const [attachedItems, setAttachedItems] = useState<GridBookmarkItem[]>([]);
  const [allowWrites, setAllowWrites] = useState(false);
  const [jumpMessageId, setJumpMessageId] = useState<string | null>(null);

  // Modals & UI preferences
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [developerView, setDeveloperView] = useState(false);

  const activeSessionRef = useRef(activeSessionId);
  activeSessionRef.current = activeSessionId;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 220);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const loadMeta = useCallback(async () => {
    if (!window.bookmarkApi) return;
    const data = await window.bookmarkApi.meta.get();
    setMeta(data);
  }, []);

  const loadItemsPage = useCallback(
    async (targetPage: number, append: boolean) => {
      if (!window.bookmarkApi) return;
      setLoading(true);
      try {
        const res = await window.bookmarkApi.items.list({
          page: targetPage,
          pageSize: 60,
          source: sourceFilter || undefined,
          category: categoryFilter || undefined,
          mediaType: mediaTypeFilter || undefined,
          query: debouncedQuery.trim() || undefined,
          sort: sortOrder,
        });
        setItems((prev) => (append ? [...prev, ...(res.items || [])] : res.items || []));
        setTotal(res.total ?? 0);
        setPage(res.page ?? targetPage);
        setTotalPages(Math.max(1, res.totalPages ?? 1));
      } finally {
        setLoading(false);
      }
    },
    [sourceFilter, categoryFilter, mediaTypeFilter, debouncedQuery, sortOrder],
  );

  const loadSessions = useCallback(async () => {
    if (!window.bookmarkApi) return;
    const list = await window.bookmarkApi.chat.listSessions();
    if (list.length === 0) {
      const created = await window.bookmarkApi.chat.createSession("新对话");
      setSessions([created]);
      setActiveSessionId(created.id);
      setMessages([]);
    } else {
      setSessions(list);
      setActiveSessionId((curr) =>
        list.some((s) => s.id === curr) ? curr : list[0].id,
      );
    }
  }, []);

  const loadMessages = useCallback(async (sessionId: string) => {
    if (!window.bookmarkApi || !sessionId) return;
    const msgs = await window.bookmarkApi.chat.getMessages(sessionId);
    setMessages(msgs);
  }, []);

  // Initial bootstrap + onboarding check
  useEffect(() => {
    if (!window.bookmarkApi) return;
    void loadMeta();
    void loadSessions();
    void window.bookmarkApi.settings.get().then((p) => {
      setDeveloperView(Boolean(p.settings.developerView));
      if (!p.settings.onboardingCompleted) {
        setOnboardingOpen(true);
      }
    });
  }, [loadMeta, loadSessions]);

  // Reload items whenever filters change
  useEffect(() => {
    void loadItemsPage(1, false);
  }, [loadItemsPage]);

  // Load messages whenever active session changes
  useEffect(() => {
    if (activeSessionId) {
      void loadMessages(activeSessionId);
    }
  }, [activeSessionId, loadMessages]);

  // Subscribe to IPC push events (chat stream, sync progress, collections changed)
  useEffect(() => {
    if (!window.bookmarkApi) return;
    const unsubChat = window.bookmarkApi.chat.onStreamEvent(({ sessionId, event }) => {
      if (sessionId !== activeSessionRef.current) return;
      if (event.type === "turn_start") {
        setStreaming({ text: "", tools: [], surfaces: [] });
      } else if (event.type === "tool_call_start") {
        setStreaming((prev) => ({
          text: prev?.text || "",
          tools: [...(prev?.tools || []), { name: event.name, args: event.args }],
          surfaces: prev?.surfaces || [],
        }));
      } else if (event.type === "text_delta") {
        setStreaming((prev) => ({
          text: (prev?.text || "") + event.delta,
          tools: prev?.tools || [],
          surfaces: prev?.surfaces || [],
        }));
      } else if (event.type === "surface_ready") {
        setStreaming((prev) => ({
          text: prev?.text || "",
          tools: prev?.tools || [],
          surfaces: [...(prev?.surfaces || []), event.surface],
        }));
      } else if (event.type === "turn_complete") {
        setStreaming(null);
        void loadMessages(sessionId);
        void loadSessions();
      }
    });

    const unsubSync = window.bookmarkApi.events.onSyncProgress((ev) => {
      setSyncProgress(ev);
      if (ev.status === "done") {
        setTimeout(() => setSyncProgress(null), 5000);
      }
    });

    const unsubChanged = window.bookmarkApi.events.onCollectionsChanged(() => {
      void loadMeta();
      void loadItemsPage(1, false);
    });

    return () => {
      unsubChat();
      unsubSync();
      unsubChanged();
    };
  }, [loadMeta, loadItemsPage, loadMessages, loadSessions]);

  const handleOpenRelated = useCallback(async (itemId: string) => {
    if (!window.bookmarkApi) return;
    setRelatedLoading(true);
    try {
      const res = await window.bookmarkApi.items.related(itemId, 12);
      setRelatedView(res);
    } finally {
      setRelatedLoading(false);
    }
  }, []);

  const handleDismissRelated = useCallback(
    async (targetId: string, candidateId: string) => {
      if (!window.bookmarkApi) return;
      await window.bookmarkApi.items.dismissRelated(targetId, candidateId);
      setRelatedView((prev) =>
        prev
          ? {
              ...prev,
              related: prev.related.filter((r) => r.id !== candidateId),
              dismissedIds: [...prev.dismissedIds, candidateId],
            }
          : null,
      );
    },
    [],
  );

  const handleCardClick = useCallback(
    (itemId: string) => {
      setHighlightedId(itemId);
      const existsInLoaded = items.some((it) => it.id === itemId);
      if (!existsInLoaded) {
        void handleOpenRelated(itemId);
      } else {
        setRelatedView(null);
      }
    },
    [items, handleOpenRelated],
  );

  const handleSendMessage = useCallback(
    async (text: string) => {
      if (!window.bookmarkApi) return;
      let sid = activeSessionId;
      if (!sid) {
        const created = await window.bookmarkApi.chat.createSession("新对话");
        sid = created.id;
        setActiveSessionId(sid);
      }
      setJumpMessageId(null);
      const attachedPayload = attachedItems.map((i) => ({
        id: i.id,
        title: i.title,
        author: i.author,
        excerpt: i.excerpt,
        url: i.url,
      }));
      setAttachedItems([]);
      setStreaming({ text: "", tools: [], surfaces: [] });

      // Optimistically render user message
      setMessages((prev) => [
        ...prev,
        attachedPayload.length > 0
          ? {
              role: "user",
              type: "attached_items",
              items: attachedPayload,
              prompt: text,
            }
          : { role: "user", type: "text", text },
      ]);

      await window.bookmarkApi.chat.sendMessage({
        sessionId: sid,
        text,
        attachedItems: attachedPayload.length > 0 ? attachedPayload : undefined,
        allowWrites,
      });
    },
    [activeSessionId, attachedItems, allowWrites],
  );

  const totalCount = meta?.stats?.total_active_items ?? total;
  const sourceSummary = (meta?.stats?.by_source || [])
    .map((s) => `${s.source === "xhs" ? "小红书" : s.source === "x" ? "X" : s.source} ${s.count}`)
    .join(" · ");

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-left">
          <h1>Bookmark Agent</h1>
          <span className="badge">
            共 {totalCount} 条 {sourceSummary ? `(${sourceSummary})` : ""}
          </span>
        </div>
        <div className="header-right">
          <button
            type="button"
            className="secondary"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙️ 设置
          </button>
        </div>
      </header>

      <main className="main-split">
        <ChatPane
          sessions={sessions}
          activeSessionId={activeSessionId}
          messages={messages}
          streaming={streaming}
          attachedItems={attachedItems}
          allowWrites={allowWrites}
          developerView={developerView}
          jumpMessageId={jumpMessageId}
          onSelectSession={(sid) => {
            setJumpMessageId(null);
            setActiveSessionId(sid);
          }}
          onNewSession={async () => {
            const created = await window.bookmarkApi.chat.createSession("新对话");
            setSessions((prev) => [created, ...prev]);
            setActiveSessionId(created.id);
            setMessages([]);
            setJumpMessageId(null);
          }}
          onSearchMessages={(q) => window.bookmarkApi.chat.searchMessages(q, 20)}
          onJumpToHit={(hit: SearchMessageHit) => {
            setActiveSessionId(hit.sessionId);
            setJumpMessageId(hit.messageId);
          }}
          onSendMessage={handleSendMessage}
          onClearAttached={() => setAttachedItems([])}
          onToggleWrites={async (allow) => {
            setAllowWrites(allow);
            await window.bookmarkApi.chat.setWriteMode(allow);
          }}
          onCardClick={handleCardClick}
        />

        <BookmarkGrid
          meta={meta}
          items={items}
          total={total}
          loading={loading}
          hasMore={page < totalPages}
          sourceFilter={sourceFilter}
          categoryFilter={categoryFilter}
          mediaTypeFilter={mediaTypeFilter}
          sortOrder={sortOrder}
          searchQuery={searchQuery}
          highlightedId={highlightedId}
          relatedView={relatedView}
          relatedLoading={relatedLoading}
          syncProgress={syncProgress}
          developerView={developerView}
          onChangeSource={setSourceFilter}
          onChangeCategory={setCategoryFilter}
          onChangeMediaType={setMediaTypeFilter}
          onChangeSort={setSortOrder}
          onChangeQuery={setSearchQuery}
          onLoadMore={() => {
            if (page < totalPages && !loading) {
              void loadItemsPage(page + 1, true);
            }
          }}
          onOpenRelated={handleOpenRelated}
          onCloseRelated={() => setRelatedView(null)}
          onDismissRelated={handleDismissRelated}
          onAskAgent={(picked) => {
            setAttachedItems(picked);
          }}
          onEditItem={async (id, patch) => {
            await window.bookmarkApi.items.update(id, patch);
          }}
          onDeleteItem={async (id) => {
            await window.bookmarkApi.items.remove(id);
          }}
          onOpenExternal={(url) => {
            void window.bookmarkApi.shell.openExternal(url);
          }}
          onConfirmPending={async (itemId, categoryId) => {
            await window.bookmarkApi.meta.confirmCategory(itemId, categoryId);
          }}
        />
      </main>

      <SettingsModal
        open={settingsOpen}
        meta={meta}
        onClose={() => setSettingsOpen(false)}
        onSettingsChanged={(next) => {
          setDeveloperView(Boolean(next.developerView));
        }}
        onMetaChanged={() => {
          void loadMeta();
          void loadItemsPage(1, false);
        }}
        onReopenOnboarding={() => {
          setSettingsOpen(false);
          setOnboardingOpen(true);
        }}
      />

      <OnboardingModal
        open={onboardingOpen}
        meta={meta}
        onComplete={() => {
          setOnboardingOpen(false);
          void loadMeta();
        }}
      />
    </div>
  );
};
