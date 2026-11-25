# 执行方案：收藏管理 Agent（X 收藏 · MCP + pi agent + A2UI + Electron）

> 2026-11-19。汇总自以下文档：
> - [design.md](design.md)（总体方案）
> - [embedding-related-classify.md](embedding-related-classify.md)（相关度与分类）
> - [embedding-local-vs-cloud.md](embedding-local-vs-cloud.md)（embedding 选型）
> - [google-free-tier.md](google-free-tier.md)（模型选择与配额）
> - [../a2ui/](../a2ui/README.md)（A2UI 调研）
>
> 工期按 **1 人全职**估算，**仅供参考**，第一个里程碑结束后再校准。

---

## 0. 目标与范围

**产品目标**：一个本地 Electron 应用。左侧是聊天，右侧是收藏 Grid。
- 收藏来自 X，自动增量同步。
- 每条收藏可以右键查看「相关收藏」，以对抗遗忘、帮助串联知识。
- 收藏自动分到几个大类，可以按分类浏览。
- 可以针对一条或多条收藏与 agent 深入讨论，回答中可以出现生成式 UI（A2UI）。

**优先级**：MCP（数据与智能层）> agent > Electron 外壳。

**本期不做**：Notion、其他社交平台（但框架要通用）、本地 embedding、删除回写源站、多设备同步。

### 已锁定的决策

| 项 | 决策 |
|---|---|
| 架构 | 收藏服务做成独立的 **collections-mcp**（stdio）；Agent = **pi-agent-core** + **pi-mcp**；聊天 UI = **A2UI**（只用在聊天区）；Grid 是原生 React |
| 采集 | agent-browser + **ab-login 模式（改写为 TS）**；通用的 `SocialSource` 框架 + X 配置；只从 DOM 提取 |
| 存储 | SQLite（better-sqlite3，WAL 模式）+ FTS5 trigram；向量以 BLOB 存储，在内存中暴力检索 |
| 相关度 | embedding 召回 + 特征融合 + MMR → 可选的 **Decisions API 精判**（每次右键 1 次请求） |
| 分类 | 聚类提议分类体系 → kNN → 质心 → Decisions `choice` 兜底 → 待确认队列 |
| 模型（开发期，free tier） | embedding：`gemini-embedding-2`@768；enrich：`gemini-3.1-flash-lite`（Gemma 4 作为溢出通道）；Decisions：`gemini-decision-1`；聊天：`gemini-3.6-flash`（可替换） |
| 删除 | 只删本地（软删除墓碑） |
| 隐私 | 默认允许把收藏内容发送到云端；设置页说明 free tier 的数据政策 |

---

## 1. 技术栈与版本（2026-11-19 的 npm 最新版）

| 用途 | 包 | 版本 |
|---|---|---|
| MCP 服务端 | `@modelcontextprotocol/sdk` | 1.32.x |
| Agent loop | `@earendil-works/pi-agent-core` / `pi-ai` / `pi-mcp` | 1.5.x |
| A2UI | `@a2ui/agent` 0.1.x（服务端）· `@a2ui/react` / `@a2ui/web_core` 0.15.x（客户端） | 早期版本，**锁定精确版本** |
| Google | `@google/genai` | 3.6.x（Decisions 需要 ≥ 3.2） |
| SQLite | `better-sqlite3` | 13.x |
| 浏览器 | `agent-browser` | ≥ 0.41（本机已有 0.41.2，最新是 0.43） |
| 正文提取 | `@mozilla/readability` + `linkedom` | 0.6.x |
| 桌面端 | `electron` + `electron-vite` | 45.x |
| 运行时 | Node | 本机 v26；MCP 在 Electron 内通过 `ELECTRON_RUN_AS_NODE` 运行，**只需要一套原生模块 ABI** |

A2UI 和 pi 都在快速迭代，所以要做三件事：锁定精确版本；用一层自己的薄封装隔离它们的 API；在 CHANGELOG 里记录升级。

---

## 2. 仓库结构（pnpm monorepo）

```
bookmark-agent/
├─ packages/
│  ├─ collections-mcp/          # ★ 第一优先级
│  │  ├─ src/
│  │  │  ├─ server.ts           # 工具注册：llm 面孔（search/get_items/read_item/related/stats/add/update/remove）
│  │  │  │                      #           app 面孔（app_*）
│  │  │  ├─ config/             # 配置 schema（zod）、层级预设（free/paid）、密钥引用
│  │  │  ├─ db/                 # schema、迁移、仓储层（items/sources/embeddings/categories/pair_cache…）
│  │  │  ├─ auth/               # ab-login 的 TS 移植：identity、check/handoff/open、SecretStore
│  │  │  ├─ sources/            # SocialSource 框架（滚动、去重、增量、健康检查）
│  │  │  │  └─ x/               #   X 配置 + extract.js + detail.js
│  │  │  ├─ content/            # read_item：推文详情和线程、链接正文提取（readability）
│  │  │  ├─ ai/
│  │  │  │  ├─ limiter.ts       #   每个模型的令牌桶（RPM/TPM/RPD）、429 退避、优先级
│  │  │  │  ├─ cache.ts         #   磁盘缓存 hash(model+promptVersion+input)
│  │  │  │  ├─ enrich.ts        #   卡片生成（摘要/主题/形态/图片描述）
│  │  │  │  ├─ embedder/        #   Embedder 接口 + gemini-embedding-2（以后加 local）
│  │  │  │  └─ decisions.ts     #   Decisions 客户端（v1beta 的封装隔离）
│  │  │  ├─ index/              # VectorIndex（内存）+ FTS + RRF 混合检索
│  │  │  ├─ related/            # 召回 → 特征 → 精判 → MMR → signals
│  │  │  ├─ classify/           # 分类体系提议、kNN/质心、Decisions 兜底、待确认队列
│  │  │  └─ jobs/               # 后台任务：同步、enrich、embed、重新分类、重建索引（带进度通知）
│  │  └─ test/ fixtures/        # X DOM 快照、录制好的模型响应
│  ├─ agent-core/               # pi Agent + MCP 桥接 + A2UI 处理器（与传输方式无关，dev-web 和 Electron 共用）
│  ├─ catalog/                  # A2UI catalog.json + React 组件实现（CollectionCard、ItemGrid…）+ 宏
│  ├─ dev-web/                  # 最简验证页：Vite React + 一个小型 SSE 服务（A1 阶段使用）
│  ├─ app/                      # Electron（E 阶段）
│  └─ eval/                     # 标注集、离线评测脚本、对话评测
└─ docs/                        # 即本目录下的这些设计文档
```

---

## 3. 里程碑

### W1 · Spike：先验证三个最大的不确定性（约 3–4 天）

目的：在写正式代码之前，先排除"根本走不通"的风险。

| # | 任务 | 产出 | 通过标准 |
|---|---|---|---|
| S1 | 用 **ab-login 原版脚本**为 X 建立 identity（`x-prod-<handle>`），完成交接登录 | identity 配置 | `ab-login check` 返回 VALID |
| S2 | 用 agent-browser 打开 `x.com/i/bookmarks`，手写一版 extract 脚本，滚动抓取约 200 条 | `fixtures/x/bookmarks.json` + 若干 **DOM 快照**（HTML） | 字段填充率：id、url、text、author、time ≥ 95%；确认虚拟滚动和收藏时间排序的行为 |
| S3 | 用 free tier key 调通三个 API：`gemini-embedding-2`（含图片）、`gemini-3.1-flash-lite`（结构化输出）、`gemini-decision-1`（`score` 和 `choice` 问题） | 三段可运行的示例脚本 + **在 AI Studio 查到的实际限流值** | 三个都能返回结果；把限流值写进配置预设 |
| S4 | 用 S2 的 200 条数据，跑一遍"enrich → embed → 手工查看 5 个目标的 top-10 相似结果" | 一份简短笔记 | 主观判断相关结果是否有意义（作为是否继续的依据） |

> S2 的数据就是之后**所有开发和测试的 dev set**。我没有确认 X 官方的数据导出是否包含书签，所以不依赖它。
> 全程遵守 browser-login 的规则：不读取 cookie、storage、网络 header。

### M0 · MCP 数据底座（约 1 周）

| 任务 | 说明 |
|---|---|
| 配置与 SecretStore | zod schema；密钥优先从 env 读取，其次是 macOS Keychain（开发期，参考 ab-login 的 `security` 命令），Electron 阶段改用 safeStorage 注入 |
| DB schema 与迁移 | design.md §4.1 中的全部表 + `items_fts`（trigram）；软删除、`user_overrides`、`(source, account, source_item_id)` 唯一约束 |
| 导入 | 从 fixtures JSON 导入，入库逻辑与以后的同步共用同一条 upsert 路径 |
| 工具（LLM 面孔） | `search`（先只用 FTS，查询少于 3 个字时降级为 LIKE）、`get_items`、`stats`、`add`（URL → 抓取 og 元数据）、`remove` |
| 工具（App 面孔） | `app_list_items`（分页、过滤、排序） |
| 接入 Claude Code | `claude mcp add collections -- node packages/collections-mcp/dist/server.js` |

**通过标准**：在 Claude Code 中能用中文和英文提问，例如"我收藏过哪些关于 Rust 异步的推文"，结果准确；删除后重新导入，条目不会"复活"；用户编辑过的字段不会被覆盖。

### M1 · X 采集（约 1.5–2 周）

| 任务 | 说明 |
|---|---|
| ab-login 移植 | `auth/`：identity 存储、`check` / `handoff` / `open`（never-save）/ `forget`；直接调用 agent-browser 的 `--restore*` 参数；会话串行 |
| `SocialSource` 框架 | 滚动循环（随机停顿）、按 id 去重、增量停止（遇到 cursor）、`maxIdleRounds`、健康检查（字段填充率） |
| X 配置 | `extract.js`（基于 S2 的版本）、`detail.js`（推文详情、线程、引用推文、链接卡片） |
| 同步任务 | `app_sync(sourceId)`：带 progressToken 的进度通知；结束时发 `collections/changed` 通知；更新 cursor |
| 登录流程 | 同步前检查，过期时返回结构化错误 `NEEDS_LOGIN {sourceId}`；`app_login_check` / `app_login_handoff` |
| `read_item` | 推文：打开详情页取全文和线程；链接：fetch + readability（需要登录的页面走 agent-browser 会话）；结果缓存到 `item_content` |
| 离线测试 | extract 脚本针对**保存下来的 DOM 快照**做单元测试，不必每次都访问 X |

**通过标准**：
- 首次全量同步成功。
- 在 X 上新增 3 条收藏后，增量同步**恰好**新增 3 条。
- 手动执行 `ab-login forget` 后：同步返回 NEEDS_LOGIN → 交接登录 → 同步继续。
- 健康检查能在 extract 被故意改坏时报警。

### M2 · 智能层（约 2 周）

| 顺序 | 任务 | 说明 |
|---|---|---|
| 1 | `ai/limiter` + `ai/cache` | **最先做**：所有模型调用都必须经过这两层（参见 free-tier §4、§5） |
| 2 | enrich | `gemini-3.1-flash-lite`，结构化输出 `{summary, topics, kind, lang, imageCaptions}`；记录 `enrich_model` 和 `prompt_version`；溢出时切到 Gemma 4 |
| 3 | Embedder + 索引 | `gemini-embedding-2`@768（文本加最多 4 张图）；`embeddings` 表；VectorIndex 启动时加载、增量 upsert |
| 4 | 混合检索 | `search` 升级为 FTS + 向量的 RRF 融合 |
| 5 | `related` | 召回（向量 50 + FTS 20 + 同作者 10）→ 重复分组 → 特征融合 → MMR → signals；`app_related` 与 LLM 工具共用同一实现 |
| 6 | 分类 | `app_taxonomy_propose`（k-means + LLM 命名）→ 用户确认 → kNN 和质心分类 → 待确认队列（`app_pending`、`app_confirm`）→ 修改后自动重新分类 |
| 7 | 评测集 | `eval/related.jsonl`（30 个目标 × 候选 0–3 级，可以先用强模型预标注再人工校对）、`eval/classify.jsonl`（200 条） |
| 8 | Decisions | 精判（`score` 4 级）与分类兜底（`choice` 加顺带标注）；`pair_cache`；**在评测集上做开与关的对比** |

**通过标准**：
- 评测报告：只用 embedding / 加特征融合 / 再加精判，三种配置的 nDCG@10、P@10；分类准确率和自动覆盖率。
- 性能：`related` 不精判时 < 300 ms，加精判时 < 2.5 s。
- 用 dev set 首次导入一遍，限速队列不报错，配额用完时能暂停并恢复。
- 根据评测结果，**决定 Decisions 精判和兜底默认开还是关**。

### A1 · 自己的 Agent（约 1.5–2 周，**M0 完成后即可与 M1、M2 并行**）

| 任务 | 说明 |
|---|---|
| `agent-core` | pi `Agent` + pi-mcp：连接 collections-mcp，**过滤掉 `app_*` 工具**再交给 LLM；写操作（add/update/remove）在 `beforeToolCall` 里要求确认 |
| A2UI 桥接 | `A2uiGenerator` + `promptSnippet` 放进固定的 system 前缀；`text_delta` → `openStream().feed()` → SSE；编译失败时用 `finishTurn` 重试 1 次，再失败就降级为纯文本 |
| catalog | Basic Catalog + `CollectionCard(id)`（**宏**：由服务端调用 `get_items` 展开，LLM 不复述数据）、`ItemGrid([ids])`、`ThemeCompare`、`Timeline` |
| 消息类型 | `attached_items`（Grid 选中的条目进入对话）、`ui_action`；`convertToLlm` 负责转换 |
| 上下文管理 | 当前 surface 用 Express 反编译放进上下文，旧 surface 只保留摘要；会话保存到 `app.db`（消息 + A2UI 消息，可以重放） |
| 系统提示词 | 先在收藏范围内检索（`search` / `related` / `read_item`）；引用收藏时用卡片展示；简单问题直接用文字回答；需要外部知识时明确说明 |
| dev-web | 左侧聊天（`@a2ui/react`），右侧简单列表（调用 `app_list_items`）；点击卡片 → 在列表中高亮 |
| 对话评测 | 约 20 个场景（单条深挖、多条比较、主题回顾、"为什么相关"、应当只回文字的反例）；指标：工具调用是否正确、A2UI 编译通过率、LLM-as-judge 质量评分、首字延迟和首次绘制时间 |

**通过标准**：对话评测集的 A2UI 编译通过率 ≥ 95%；"应当只回文字"的反例中，**没有过度使用 UI**；回答中引用的收藏 id 全部真实存在。

### E · Electron 外壳（约 2–3 周）

| 任务 | 说明 |
|---|---|
| 进程模型 | main 进程 + `utilityProcess` 运行 agent-core；collections-mcp 作为子进程（`ELECTRON_RUN_AS_NODE`，stdio）；renderer 只通过 IPC 通信，**不接触任何 key** |
| Grid | 虚拟滚动；封面缓存到本地；分类筛选；排序；编辑和删除；**右键「相关收藏」→ 关联视图**（目标置顶、按 signals 分组、"不相关"反馈按钮）；多选 →「问问 Agent」 |
| 联动 | 聊天中的卡片 ↔ Grid 高亮定位；同步进度条；`collections/changed` 触发增量刷新 |
| 设置 | 模型提供方和 key（safeStorage → 注入 MCP 的 env）；层级 free/paid（对应限流预设）；来源状态（VALID/EXPIRED，"重新登录"按钮）；分类体系编辑；隐私和数据政策说明 |
| 历史与搜索 | 会话列表（标题由 LLM 生成）；FTS（trigram）搜索消息，并跳转到对应位置 |
| Onboarding | 填 key → 连接 X（交接登录）→ 首次同步 → 确认分类体系 → 后台完成 enrich 和 embedding |
| 打包 | 检测 agent-browser（缺失或版本过低时引导安装）；better-sqlite3 针对 Electron 重新编译；macOS 签名放到后续再做 |

**通过标准**：在一台新机器上从安装到看到第一批带分类的收藏，全程不需要命令行；右键相关收藏和聊天联动都能正常工作。

---

## 4. 时间线（参考）

```
周次   1    2    3    4    5    6    7    8    9    10
W1   ███
M0      ████
M1           ██████
M2                 ████████
A1           ██████████          ← M0 之后开始，与 M1、M2 并行
E                          ██████████
```

一人全职约 **9–10 周**。如果只做到 A1（通过 dev-web 体验完整的 agent 功能），约 **6–7 周**。

---

## 5. 横切事项

| 项 | 要求 |
|---|---|
| **安全** | 遵守 browser-login 的规则：代码和日志中**永不读取或输出** cookie、storage、网络 header。工具返回的错误信息里不能带凭证。`action.context` 和 `dataModel` 都视为不可信输入。外部内容中的链接只能由用户手势打开 |
| **配额** | 所有 AI 调用都经过 limiter + cache；用户交互的优先级高于后台任务；RPD 用完就暂停到太平洋时间午夜 |
| **可复现** | 卡片记录 `enrich_model` 和 `prompt_version`，向量记录 `embedder_id`；改提示词或换模型后只重跑受影响的条目 |
| **测试** | 单元测试使用录制好的模型响应和 DOM 快照，不调用真实服务；评测脚本单独运行（`pnpm eval:*`） |
| **可观测性** | 记录每个工具调用的耗时；同步统计（新增数、字段填充率）；每个模型的配额消耗；A2UI 编译失败率 |
| **数据位置** | `~/Library/Application Support/<app>/`：`collections.db`（属于 MCP）、`app.db`（属于 App）、`covers/`、`llm-cache/` |

---

## 6. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| X 改版或风控 | 同步中断，或账号受限 | 健康检查告警；DOM 快照测试；低频、串行、随机停顿；支持手动导入作为兜底 |
| Free tier 限流比预期更紧 | 首次导入很慢 | S3 先查清实际限流；限速队列支持多天分批完成；Gemma 4 溢出；必要时转付费（约 2–3 美元） |
| Decisions API（v1beta）接口变化 | 精判和兜底失效 | 封装在 `ai/decisions.ts`；可以通过开关回退到只用 embedding 和特征融合 |
| A2UI 和 pi 的早期版本在升级时出现破坏性变更 | agent 层需要返工 | 锁定版本；用薄封装隔离 API；A2UI 渲染失败时降级为纯文本 |
| 相关收藏的效果主观上不明显 | 核心卖点不成立 | W1 的 S4 先做主观检查；M2 用评测集量化；"同一时期收藏"等 signals 作为补充 |
| Free tier 数据政策 | 隐私顾虑 | 设置页明确说明；正式使用时切换到付费层 |

---

## 7. 第一周的具体任务清单

- [ ] 初始化 pnpm monorepo，创建 `collections-mcp` 包的骨架（TS、vitest、eslint）
- [ ] S1：在 `identities.json` 中新增 `x-prod-<handle>`，然后执行 `ab-login handoff`
- [ ] S2：编写 extract 脚本，抓取约 200 条，保存 JSON 和 DOM 快照
- [ ] S3：申请或确认 Google key；跑通三个 API 的示例；从 AI Studio 记下各模型的 free tier 限流
- [ ] S4：用 200 条数据快速跑一遍 enrich → embed → 相似度，记下主观判断
- [ ] 写出 `db/schema.sql` 初稿，配置 Claude Code 的 deny 规则（`Read(~/.agent-browser/**)` 等）
- [ ] 根据 W1 的结果，校准 M0–E 的工期
