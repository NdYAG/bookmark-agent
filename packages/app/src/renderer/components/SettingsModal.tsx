import React, { useEffect, useState } from "react";
import type {
  AppSettings,
  CategoryInfo,
  EnvCheckResult,
  MetaResponse,
  ModelTier,
  SafeSettingsPayload,
} from "../../shared/types";

interface SettingsModalProps {
  open: boolean;
  meta: MetaResponse | null;
  onClose: () => void;
  onSettingsChanged?: (settings: AppSettings) => void;
  onMetaChanged: () => void;
  onReopenOnboarding: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  meta,
  onClose,
  onSettingsChanged,
  onMetaChanged,
  onReopenOnboarding,
}) => {
  const [tab, setTab] = useState<"models" | "sources" | "categories" | "privacy">("models");
  const [payload, setPayload] = useState<SafeSettingsPayload | null>(null);
  const [envInfo, setEnvInfo] = useState<EnvCheckResult | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [chatModel, setChatModel] = useState("gemini-3.1-flash-lite");
  const [tier, setTier] = useState<ModelTier>("paid");
  const [allowCloud, setAllowCloud] = useState(true);
  const [developerView, setDeveloperView] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  const [sourceStatuses, setSourceStatuses] = useState<Record<string, string>>({});
  const [categoriesDraft, setCategoriesDraft] = useState<CategoryInfo[]>([]);

  useEffect(() => {
    if (!open || !window.bookmarkApi) return;
    setStatusMsg("");
    void window.bookmarkApi.settings.get().then((p) => {
      setPayload(p);
      setChatModel(p.settings.chatModel);
      setTier(p.settings.tier);
      setAllowCloud(p.settings.allowCloudForContent);
      setDeveloperView(Boolean(p.settings.developerView));
    });
    void window.bookmarkApi.settings.checkEnv().then(setEnvInfo);
    setCategoriesDraft(meta?.categories ? [...meta.categories] : []);
  }, [open, meta]);

  if (!open) return null;

  const handleSaveSettings = async () => {
    const next = await window.bookmarkApi.settings.save({
      chatModel,
      tier,
      allowCloudForContent: allowCloud,
      developerView,
    });
    setPayload(next);
    onSettingsChanged?.(next.settings);
    setStatusMsg("设置已保存并生效。");
  };

  const handleSaveApiKey = async () => {
    const next = await window.bookmarkApi.settings.setApiKey(apiKeyInput);
    setPayload(next);
    setApiKeyInput("");
    setStatusMsg("API Key 已通过系统 safeStorage 加密保存，已注入后台 MCP 进程。");
  };

  const handleCheckLogin = async (sourceId: string) => {
    setSourceStatuses((prev) => ({ ...prev, [sourceId]: "检查中..." }));
    const res = await window.bookmarkApi.sources.loginCheck(sourceId);
    setSourceStatuses((prev) => ({
      ...prev,
      [sourceId]: res?.status || "UNKNOWN",
    }));
  };

  const handleLoginHandoff = async (sourceId: string) => {
    setSourceStatuses((prev) => ({ ...prev, [sourceId]: "正在打开登录窗口..." }));
    const res = await window.bookmarkApi.sources.loginHandoff(sourceId);
    setSourceStatuses((prev) => ({
      ...prev,
      [sourceId]: res?.status || "DONE",
    }));
  };

  const handleSaveCategories = async () => {
    await window.bookmarkApi.meta.editCategories(
      categoriesDraft.map((c, idx) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        examples: c.examples,
        sort: idx + 1,
      })),
    );
    setStatusMsg("分类体系已保存，自动分配的条目已重新分类。");
    onMetaChanged();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <h3>设置 · Bookmark Agent</h3>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="settings-tabs">
          <button
            type="button"
            className={`tab-btn ${tab === "models" ? "active" : ""}`}
            onClick={() => setTab("models")}
          >
            模型与 Key
          </button>
          <button
            type="button"
            className={`tab-btn ${tab === "sources" ? "active" : ""}`}
            onClick={() => setTab("sources")}
          >
            社媒来源
          </button>
          <button
            type="button"
            className={`tab-btn ${tab === "categories" ? "active" : ""}`}
            onClick={() => setTab("categories")}
          >
            分类体系
          </button>
          <button
            type="button"
            className={`tab-btn ${tab === "privacy" ? "active" : ""}`}
            onClick={() => setTab("privacy")}
          >
            偏好与隐私
          </button>
        </div>

        {statusMsg && <div className="info-banner">{statusMsg}</div>}

        {tab === "models" && (
          <div className="settings-body">
            <div className="field-group">
              <div className="field-title">Google Gemini API Key（安全存储于 safeStorage）</div>
              <div className="muted-sm">
                当前状态：
                {payload?.apiKeyStatus.hasKey
                  ? `已配置 (${payload.apiKeyStatus.masked} · 来源: ${payload.apiKeyStatus.source})`
                  : "未配置"}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="输入新的 Gemini API Key（留空点保存可清除）"
                  style={{ flex: 1 }}
                />
                <button type="button" onClick={handleSaveApiKey}>
                  加密保存 Key
                </button>
              </div>
            </div>

            <div className="field-group">
              <label className="field-label">
                聊天模型（Gemini）
                <input
                  type="text"
                  value={chatModel}
                  onChange={(e) => setChatModel(e.target.value)}
                />
              </label>
            </div>

            <div className="field-group">
              <label className="field-label">
                配额层级（限流预设）
                <select value={tier} onChange={(e) => setTier(e.target.value as ModelTier)}>
                  <option value="paid">Paid Tier（高吞吐：3000 RPM / 500K RPD）</option>
                  <option value="free">Free Tier（免费层：100 RPM / 1000 RPD，自动退避）</option>
                </select>
              </label>
            </div>

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onReopenOnboarding}>
                重新运行新手引导
              </button>
              <button type="button" onClick={handleSaveSettings}>
                保存模型配置
              </button>
            </div>
          </div>
        )}

        {tab === "sources" && (
          <div className="settings-body">
            {(meta?.sources || [{ id: "x" }, { id: "xhs" }]).map((s: any) => (
              <div key={s.id} className="source-row">
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {s.id === "xhs" ? "📕 小红书 (xhs)" : s.id === "x" ? "𝕏 X (Twitter)" : s.id}
                  </div>
                  <div className="muted-sm">
                    登录状态：{sourceStatuses[s.id] || s.last_status || "未检测"} · 上次同步：
                    {s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : "尚未同步"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => handleCheckLogin(s.id)}
                  >
                    检查状态
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => handleLoginHandoff(s.id)}
                  >
                    重新登录
                  </button>
                  <button
                    type="button"
                    onClick={() => window.bookmarkApi.sources.sync(s.id, 200)}
                  >
                    立即同步
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "categories" && (
          <div className="settings-body">
            <div className="category-editor-list">
              {categoriesDraft.map((cat, idx) => (
                <div key={cat.id} className="category-editor-row">
                  <input
                    type="text"
                    value={cat.name}
                    onChange={(e) => {
                      const next = [...categoriesDraft];
                      next[idx] = { ...cat, name: e.target.value };
                      setCategoriesDraft(next);
                    }}
                    placeholder="分类名称"
                  />
                  <input
                    type="text"
                    value={cat.description}
                    onChange={(e) => {
                      const next = [...categoriesDraft];
                      next[idx] = { ...cat, description: e.target.value };
                      setCategoriesDraft(next);
                    }}
                    placeholder="分类说明"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="ghost danger-ghost"
                    onClick={() =>
                      setCategoriesDraft((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setCategoriesDraft((prev) => [
                    ...prev,
                    {
                      id: `cat-${Date.now().toString(36)}`,
                      name: "新分类",
                      description: "",
                      examples: [],
                      sort: prev.length + 1,
                    },
                  ])
                }
              >
                + 新增分类
              </button>
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  setStatusMsg("正在聚类并为每个簇命名…");
                  const res = await window.bookmarkApi.meta.proposeTaxonomy(false);
                  onMetaChanged();
                  const count = res?.categories?.length ?? 0;
                  const moved = res?.userLabels
                    ? `；已确认的归类：沿用 ${res.userLabels.remapped}，待重新确认 ${res.userLabels.toPending}`
                    : "";
                  setStatusMsg(
                    res?.error === "NOT_ENOUGH_VECTORS"
                      ? `当前仅有 ${res.totalVectors ?? 0} 条向量化收藏，至少需要 ${res.minVectors ?? 25} 条才能自动聚类（也可在上方手动新增分类）。`
                      : !res?.categories
                        ? `提议分类体系失败：${res?.message || "请检查配置后重试"}`
                        : res.nameSource === "llm"
                          ? `已按向量聚类提议 ${count} 个分类，由 ${res.namerModel} 命名${moved}。`
                          : `已按向量聚类提议 ${count} 个分类，暂用高频主题词命名（${res.fallbackReason ?? "LLM 暂不可用"}，后续将自动重试命名）${moved}。`,
                  );
                }}
              >
                聚类自动提议
              </button>
              <button type="button" onClick={handleSaveCategories}>
                保存分类体系
              </button>
            </div>
          </div>
        )}

        {tab === "privacy" && (
          <div className="settings-body">
            <label className="write-toggle" style={{ fontSize: "var(--fs-md)" }}>
              <input
                type="checkbox"
                checked={developerView}
                onChange={async (e) => {
                  const checked = e.target.checked;
                  setDeveloperView(checked);
                  const next = await window.bookmarkApi.settings.save({
                    developerView: checked,
                  });
                  setPayload(next);
                  onSettingsChanged?.(next.settings);
                }}
              />
              Developer view（显示卡片 ID、原始精判信号分组与调试信息）
            </label>
            <label className="write-toggle" style={{ fontSize: "var(--fs-md)" }}>
              <input
                type="checkbox"
                checked={allowCloud}
                onChange={(e) => setAllowCloud(e.target.checked)}
              />
              允许将收藏内容发送至云端模型（用于语义检索、相关度精判与对话回答）
            </label>
            <div className="policy-box">
              <strong>数据与隐私说明：</strong>
              <ul>
                <li>所有收藏原文、向量、分类与历史对话均保存在本机 SQLite（<code>collections.db</code> 与 <code>app.db</code>）。</li>
                <li>API Key 使用 Electron <code>safeStorage</code> 加密保存，仅由主进程注入后台子进程，渲染进程永不接触明文密钥。</li>
                <li>使用 Google AI Studio Free Tier 时，Google 可能将请求用于改进产品；正式长期使用建议切换至 Paid Tier（约 $2–3 覆盖数千条首次导入）。</li>
                <li>遵循 <code>browser-login</code> 边界：同步过程永不读取或记录 Cookie / LocalStorage / 请求头。</li>
              </ul>
            </div>
            {envInfo && (
              <div className="policy-box">
                <strong>浏览器采集环境检测（agent-browser）：</strong>
                <div>{envInfo.message}</div>
                {!envInfo.ok && (
                  <div className="muted-sm" style={{ marginTop: 4 }}>
                    安装/升级命令：<code>{envInfo.installCommand}</code>
                  </div>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" onClick={handleSaveSettings}>
                保存隐私设置
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
