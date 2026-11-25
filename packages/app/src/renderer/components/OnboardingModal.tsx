import React, { useEffect, useState } from "react";
import type { EnvCheckResult, MetaResponse, SafeSettingsPayload } from "../../shared/types";

interface OnboardingModalProps {
  open: boolean;
  meta: MetaResponse | null;
  onComplete: () => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  open,
  meta,
  onComplete,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [envInfo, setEnvInfo] = useState<EnvCheckResult | null>(null);
  const [settingsPayload, setSettingsPayload] = useState<SafeSettingsPayload | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [loginStatus, setLoginStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !window.bookmarkApi) return;
    void window.bookmarkApi.settings.checkEnv().then(setEnvInfo);
    void window.bookmarkApi.settings.get().then(setSettingsPayload);
  }, [open]);

  if (!open) return null;

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return;
    setBusy(true);
    try {
      const next = await window.bookmarkApi.settings.setApiKey(apiKeyInput.trim());
      setSettingsPayload(next);
      setApiKeyInput("");
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async (sourceId: "x" | "xhs") => {
    setLoginStatus((prev) => ({ ...prev, [sourceId]: "打开登录窗口中..." }));
    const res = await window.bookmarkApi.sources.loginHandoff(sourceId);
    setLoginStatus((prev) => ({ ...prev, [sourceId]: res?.status || "完成" }));
  };

  const finishOnboarding = async () => {
    await window.bookmarkApi.settings.save({ onboardingCompleted: true });
    onComplete();
  };

  const totalItems = meta?.stats?.total_active_items ?? 0;

  return (
    <div className="modal-backdrop">
      <div className="modal-card modal-wide">
        <div className="modal-header-row">
          <h3>欢迎使用 Bookmark Agent（步骤 {step} / 3）</h3>
          <button type="button" className="ghost" onClick={finishOnboarding}>
            跳过引导
          </button>
        </div>

        {step === 1 && (
          <div className="settings-body">
            <p className="muted-sm">
              第一步：检查本地浏览器采集环境，并配置 Google Gemini API Key（用于语义检索、相关收藏与 A2UI 对话）。
            </p>
            {envInfo && (
              <div className="policy-box">
                <strong>环境检测：</strong> {envInfo.message}
                {!envInfo.ok && (
                  <div className="muted-sm" style={{ marginTop: 4 }}>
                    请先运行：<code>{envInfo.installCommand}</code>
                  </div>
                )}
              </div>
            )}
            <div className="field-group">
              <div className="field-title">Gemini API Key</div>
              <div className="muted-sm">
                当前状态：
                {settingsPayload?.apiKeyStatus.hasKey
                  ? `已就绪 (${settingsPayload.apiKeyStatus.masked})`
                  : "未配置（可先浏览本地收藏，聊天/向量检索需要 Key）"}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="粘贴 Gemini API Key（通过 safeStorage 加密保存）"
                  style={{ flex: 1 }}
                />
                <button type="button" disabled={busy} onClick={handleSaveKey}>
                  保存 Key
                </button>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setStep(2)}>
                下一步：连接社媒来源 →
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="settings-body">
            <p className="muted-sm">
              第二步：连接你的 X 或小红书账号（使用无自动化特征的独立 Chrome 窗口手动登录，凭证仅存本机）。当前本地库已有 <strong>{totalItems}</strong> 条收藏。
            </p>
            <div className="source-row">
              <div>
                <strong>𝕏 X (Twitter)</strong>
                <div className="muted-sm">状态：{loginStatus.x || "可选连接"}</div>
              </div>
              <button type="button" className="secondary" onClick={() => handleConnect("x")}>
                连接 X 账号
              </button>
            </div>
            <div className="source-row">
              <div>
                <strong>📕 小红书 (Xiaohongshu)</strong>
                <div className="muted-sm">状态：{loginStatus.xhs || "可选连接"}</div>
              </div>
              <button type="button" className="secondary" onClick={() => handleConnect("xhs")}>
                连接小红书账号
              </button>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setStep(1)}>
                ← 上一步
              </button>
              <button type="button" onClick={() => setStep(3)}>
                下一步：确认分类体系 →
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="settings-body">
            <p className="muted-sm">
              第三步：确认当前分类体系（共 {meta?.categories.length ?? 0} 个一级分类，覆盖 {totalItems} 条多平台收藏）。你随时可以在「设置 → 分类体系」中调整。
            </p>
            <div className="pill-row" style={{ gap: 8 }}>
              {(meta?.categories || []).map((c) => (
                <span key={c.id} className="badge">
                  {c.name}
                </span>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setStep(2)}>
                ← 上一步
              </button>
              <button type="button" onClick={finishOnboarding}>
                完成并进入收藏库 ✨
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
