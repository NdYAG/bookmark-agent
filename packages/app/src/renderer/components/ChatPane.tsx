import React, { useEffect, useRef, useState } from "react";
import type {
  A2uiSurfaceSpec,
  AgentMessage,
  GridBookmarkItem,
  SearchMessageHit,
  SessionRecord,
} from "../../shared/types";
import { splitTextBySurfaces } from "@bookmark-agent/catalog";
import { A2uiSurface } from "./A2uiSurface";
import { MarkdownText } from "./MarkdownText";

export interface StreamingDraft {
  text: string;
  tools: Array<{ name: string; args: Record<string, unknown> }>;
  surfaces: A2uiSurfaceSpec[];
}

interface ChatPaneProps {
  sessions: SessionRecord[];
  activeSessionId: string;
  messages: AgentMessage[];
  streaming: StreamingDraft | null;
  attachedItems: GridBookmarkItem[];
  allowWrites: boolean;
  developerView?: boolean;
  jumpMessageId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onSearchMessages: (query: string) => Promise<SearchMessageHit[]>;
  onJumpToHit: (hit: SearchMessageHit) => void;
  onSendMessage: (text: string) => void;
  onClearAttached: () => void;
  onToggleWrites: (allow: boolean) => void;
  onCardClick: (itemId: string) => void;
}

export const ChatPane: React.FC<ChatPaneProps> = ({
  sessions,
  activeSessionId,
  messages,
  streaming,
  attachedItems,
  allowWrites,
  developerView = false,
  jumpMessageId,
  onSelectSession,
  onNewSession,
  onSearchMessages,
  onJumpToHit,
  onSendMessage,
  onClearAttached,
  onToggleWrites,
  onCardClick,
}) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [input, setInput] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchMessageHit[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!jumpMessageId) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    } else {
      const targetEl = document.querySelector(`[data-msg-id="${jumpMessageId}"]`);
      targetEl?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [messages, streaming, jumpMessageId]);

  useEffect(() => {
    const q = historyQuery.trim();
    if (!q) {
      setSearchHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void onSearchMessages(q).then(setSearchHits);
    }, 200);
    return () => clearTimeout(timer);
  }, [historyQuery, onSearchMessages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed && attachedItems.length === 0) return;
    onSendMessage(trimmed || "请帮我分析这些收藏");
    setInput("");
  };

  return (
    <div className="chat-shell">
      {/* Collapsible History & FTS5 Search Sidebar */}
      {sidebarOpen && (
        <aside className="history-sidebar">
          <div className="sidebar-top">
            <button type="button" style={{ flex: 1 }} onClick={onNewSession}>
              + 新对话
            </button>
          </div>
          <div className="sidebar-search">
            <input
              type="text"
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
              placeholder="全文搜索历史消息..."
            />
          </div>

          {historyQuery.trim() ? (
            <div className="sidebar-list">
              <div className="sidebar-section-label">搜索结果 ({searchHits.length})</div>
              {searchHits.length === 0 && (
                <div className="muted-sm" style={{ padding: "8px 10px" }}>
                  无匹配消息
                </div>
              )}
              {searchHits.map((hit) => (
                <button
                  key={hit.messageId}
                  type="button"
                  className="session-item"
                  onClick={() => {
                    onJumpToHit(hit);
                    setHistoryQuery("");
                  }}
                >
                  <div className="session-title">{hit.sessionTitle}</div>
                  <div className="session-preview">{hit.text.slice(0, 60)}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="sidebar-list">
              <div className="sidebar-section-label">历史会话 ({sessions.length})</div>
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`session-item ${s.id === activeSessionId ? "active" : ""}`}
                  onClick={() => onSelectSession(s.id)}
                >
                  <div className="session-title">{s.title}</div>
                  <div className="session-preview">{s.message_count ?? 0} 条消息</div>
                </button>
              ))}
            </div>
          )}
        </aside>
      )}

      {/* Main Chat + A2UI Column */}
      <section className="chat-pane">
        <div className="chat-subheader">
          <button
            type="button"
            className="ghost"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            {sidebarOpen ? "◀ 隐藏历史" : "▶ 会话历史"}
          </button>
          <label className="write-toggle">
            <input
              type="checkbox"
              checked={allowWrites}
              onChange={(e) => onToggleWrites(e.target.checked)}
            />
            允许写操作 (add/update/remove)
          </label>
        </div>

        <div className="chat-messages">
          {messages.length === 0 && !streaming && (
            <div className="msg assistant">
              <div className="msg-text">
                你好！我是你的个人收藏管理 Agent，已接入 X 与小红书的全部收藏。你可以直接提问检索、跨平台对比主题，或者在右侧右键查看「相关收藏」/ 多选条目一起探讨。点击回答中的 A2UI 卡片可在右侧自动高亮定位。
              </div>
            </div>
          )}

          {messages.map((m, idx) => {
            const msgId = m.id || `m-${idx}`;
            const isJumpTarget = jumpMessageId && msgId === jumpMessageId;
            if (m.role === "user") {
              const display =
                m.type === "attached_items"
                  ? `[附带 ${m.items.length} 条收藏] ${m.prompt || ""}`
                  : m.type === "text"
                    ? m.text
                    : `[UI Action] ${m.action}`;
              return (
                <div
                  key={msgId}
                  data-msg-id={msgId}
                  className={`msg user ${isJumpTarget ? "jump-highlight" : ""}`}
                >
                  <div className="msg-text">{display}</div>
                </div>
              );
            }

            return (
              <div
                key={msgId}
                data-msg-id={msgId}
                className={`msg assistant ${isJumpTarget ? "jump-highlight" : ""}`}
              >
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="tool-pills">
                    {m.toolCalls.map((tc, ti) => (
                      <span key={ti} className="tool-pill">
                        🔧 {tc.name}
                      </span>
                    ))}
                  </div>
                )}
                <AnswerBody
                  text={m.text}
                  surfaces={m.surfaces}
                  onCardClick={onCardClick}
                  developerView={developerView}
                />
              </div>
            );
          })}

          {streaming && (
            <div className="msg assistant">
              {streaming.tools.length > 0 && (
                <div className="tool-pills">
                  {streaming.tools.map((t, i) => (
                    <span key={i} className="tool-pill">
                      🔧 {t.name}
                    </span>
                  ))}
                </div>
              )}
              {streaming.text || streaming.surfaces.length > 0 ? (
                <AnswerBody
                  text={streaming.text}
                  surfaces={streaming.surfaces}
                  onCardClick={onCardClick}
                  developerView={developerView}
                  streaming
                />
              ) : (
                <div className="msg-text muted">思考中...</div>
              )}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {attachedItems.length > 0 && (
          <div className="attached-bar">
            <span>
              已附加 {attachedItems.length} 条收藏：
              {attachedItems.map((i) => i.title?.slice(0, 14) || i.id).join("、")}
            </span>
            <button type="button" className="ghost" onClick={onClearAttached}>
              清除
            </button>
          </div>
        )}

        <form className="chat-input-bar" onSubmit={handleSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="提问收藏（如：我在小红书和 X 上收藏过哪些动效设计案例？）..."
          />
          <button type="submit" disabled={Boolean(streaming)}>
            发送
          </button>
        </form>
      </section>
    </div>
  );
};

/** Assistant answer: Markdown prose with each A2UI surface rendered where the model placed it. */
function AnswerBody({
  text,
  surfaces,
  onCardClick,
  developerView = false,
  streaming = false,
}: {
  text: string;
  surfaces?: A2uiSurfaceSpec[];
  onCardClick: (itemId: string) => void;
  developerView?: boolean;
  /** While streaming, cards are compiled at the end of the turn: show a placeholder meanwhile. */
  streaming?: boolean;
}) {
  return (
    <>
      {splitTextBySurfaces(text || "", surfaces || [], { keepPending: streaming }).map((seg, i) => {
        if (seg.kind === "text") {
          return <MarkdownText key={`t${i}`} text={seg.text} onCardClick={onCardClick} />;
        }
        if (seg.kind === "pending") {
          return (
            <div key={`p${seg.index}`} className="a2ui-surface a2ui-pending" role="status">
              正在生成收藏卡片…
            </div>
          );
        }
        return (
          <A2uiSurface
            key={`s${seg.index}`}
            surface={seg.surface}
            onCardClick={onCardClick}
            developerView={developerView}
          />
        );
      })}
    </>
  );
}
