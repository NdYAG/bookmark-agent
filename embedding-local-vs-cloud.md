# Embedding：本地模型 vs 云端 API

> 2026-11-19。已核对的事实：
> - AI Studio embeddings 文档（`gemini-embedding-2` / `gemini-embedding-001`）
> - Hugging Face 上各模型的仓库与 ONNX 文件大小
> - npm：`@huggingface/transformers` 4.3.2、`node-llama-cpp` 3.22.3
>
> **吞吐量和质量的判断是经验估计，没有在你的数据上实测**，以 §6 的对比实验为准。

---

## 1. 候选

### 云端

| 模型 | 要点 |
|---|---|
| **`gemini-embedding-2`**（Google） | 最新模型；**多模态**：文本、图片（每次最多 6 张）、音频、视频、PDF **在同一个向量空间**；100+ 种语言；输入上限 8,192 token；维度 128–3072（推荐 768/1536/3072，截断后自动归一化）；**不支持 `task_type`**，改用提示前缀（查询：`task: search result \| query: …`；文档：`title: … \| text: …`）；支持 Batch API（半价） |
| `gemini-embedding-001` | 只支持文本；有 `task_type`（SEMANTIC_SIMILARITY / CLASSIFICATION / CLUSTERING / RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY …）；输入上限 2,048 token；维度不是 3072 时需要自己归一化 |
| OpenAI、Voyage、Jina、Cohere 等 | 都可以用，但**会多一个 key**；Google 方案可以和 Decisions API 共用一个 key |

### 本地（都有 transformers.js 可用的 ONNX 版本）

| 模型 | 参数量 | 量化后文件 | 维度 | 许可证 | 备注 |
|---|---|---|---|---|---|
| **EmbeddingGemma-300m** | 约 300M | q4 约 **175–200 MB**，int8 约 309 MB | 768（MRL 可截断到 512/256/128） | **Gemma 许可**（需要遵守使用条款；原始仓库需要手动同意才能下载） | 500M 以下多语言模型中较强；使用提示前缀，形式与 gemini-embedding-2 类似 |
| **Qwen3-Embedding-0.6B** | 约 600M | int8 约 **614 MB**，q4f16 约 567 MB | 最高 1024（MRL） | **Apache-2.0** | 中文能力强；查询需要加 instruct 前缀 |
| bge-m3 | 约 568M | int8 约 568 MB | 1024 | MIT | 老牌多语言模型，输入上限 8k |
| multilingual-e5-small | 约 118M | int8 约 **118 MB** | 384 | MIT | 最小最快，但质量明显弱一档；需要 `query:` / `passage:` 前缀 |

运行方式：
- **transformers.js**（onnxruntime-node，在 MCP 的 Node 进程里运行）
- **node-llama-cpp**（GGUF 格式，同样可以嵌入）
- **Ollama**（需要用户另外安装，对分发不友好）

---

## 2. 放到这个项目里逐项比较

| 维度 | 云端（gemini-embedding-2） | 本地（EmbeddingGemma / Qwen3-0.6B） | 对本项目的影响 |
|---|---|---|---|
| **质量（中英混合短文本）** | 通常是第一梯队 | EmbeddingGemma、Qwen3-0.6B 接近，e5-small 明显差一档 | 差距需要实测；推文这类短文本，**enrich 卡片的质量**往往比模型差异影响更大 |
| **图片 / 多模态** | ✅ 图文同一空间：图片帖、截图、灵感板可以直接 embed，与文字收藏互相检索 | ❌ 只能处理文本：要么先用视觉模型生成描述（又回到云端），要么再加一个 CLIP 类模型（另一个向量空间，跨模态比较要额外处理） | **X 上大量是图片帖，这是云端最实在的优势** |
| **成本** | 3,000 条 × 约 300 token ≈ 1M token，一次性；日常增量可以忽略（单价请查 pricing 页） | 零费用，但占用用户的 CPU、内存和磁盘 | 这个数据量下，**两者成本都可以忽略** |
| **首次导入速度** | 受限流约束；可以批量请求并发调用，几分钟内完成 | M 系列 CPU 估计每秒处理几条到几十条（Qwen3 更慢，e5-small 更快），3,000 条大约几分钟到二十分钟 | 都是一次性的后台任务，带进度条即可 |
| **查询延迟**（`search` 工具需要对查询做 embed） | 每次约 100–300 ms 的网络往返 | 约 10–50 ms | 相对于 LLM 的整轮延迟可以忽略；`related` 只用已存储的向量，不需要实时 embed |
| **离线能力** | ❌ | ✅ | **意义不大**：X 同步、enrich、Decisions API、聊天本来就都要联网 |
| **隐私** | 整个收藏库会**一次性**上传 | 收藏内容不离开本机 | 你已经决定允许云端；区别只在于"按需上传（聊天时）"还是"全量上传" |
| **工程量** | 一个 HTTP 客户端：重试、限流、批量 | 原生依赖（onnxruntime 要按 arm64/x64 分别打包）、**首次下载 200–600 MB 模型**（进度、断点续传、校验）、推理放在 worker 线程并限速（避免卡顿）、内存占用 0.5–1.5 GB | **本地方案额外需要几天的工程量，而且全是基础设施，不是 MCP 或 agent 功能** |
| **配置门槛** | 需要一个 Google key（和 Decisions API 共用） | 不需要 key | MCP 单独分发给别人用时（例如接入 Claude Code），本地方案的开箱体验更好；但它本来就依赖 agent-browser |
| **模型生命周期** | 云端模型会升级或下线（001 → 2），**迟早要全量重算** | 版本固定，永不变化 | 几千条全量重算只需几分钟、几分钱，**锁定风险很低** |
| **许可证** | 服务条款 | 打包进应用要注意：EmbeddingGemma 是 Gemma 许可；Qwen3、bge-m3、e5 是 Apache/MIT | 如果要打包本地模型，优先选 Qwen3 或 bge-m3；或者运行时从 HF 下载 |

---

## 3. 结论

**目标是优先做 MCP 和 agent 功能，所以默认用云端 `gemini-embedding-2`（768 维），本地模型作为后续可插拔的选项。**

理由按权重排序：
1. **工程量差距在错误的方向上**：本地方案多出来的全是基础设施（打包、下载、线程、内存），推迟了真正要验证的东西（`search`、`read_item`、`related`、分类、对话体验）。
2. **多模态是实打实的功能优势**：X 收藏里图片帖很多，云端模型直接把图文放进同一个空间，省掉"视觉模型生成描述"这一步，灵感板场景也直接受益。
3. **本地方案的两个主要优势在本项目里打了折扣**：离线（整条链路本来就要联网）和隐私（已决定允许云端）。
4. **成本和锁定都不是问题**：数据量小，重算便宜。

**什么时候切换到或增加本地方案**：要提供"离线/隐私模式"时；要把 MCP 作为独立工具分发、希望零配置时；或者 §6 的实验显示本地模型在你的数据上不比云端差。到那时首选 **Qwen3-Embedding-0.6B**（Apache 许可、中文强）或 **EmbeddingGemma q4**（体积小，注意 Gemma 许可）。

---

## 4. 为以后可切换做的设计（现在就要做，成本很低）

```ts
interface Embedder {
  readonly id: string;            // "gemini-embedding-2@768" | "qwen3-embedding-0.6b@1024" …
  readonly dim: number;
  readonly modalities: ("text" | "image")[];
  embedDocuments(docs: DocInput[]): Promise<Float32Array[]>;  // 内部负责各模型自己的文档前缀和批量
  embedQuery(q: string): Promise<Float32Array>;               // 内部负责查询前缀
}
type DocInput = { title?: string; text: string; images?: { mime: string; data: Uint8Array }[] };
```

- **前缀由 Embedder 内部处理**：gemini-embedding-2 和 EmbeddingGemma 用 `task: … | query:` / `title: … | text:`；e5 用 `query:` / `passage:`；Qwen3 只给查询加 instruct。前缀用错会明显降低质量，所以这类细节不应该泄漏到业务代码里。
- **不同模型的向量不能混用**：同一时间只有一个 `active_embedder`。切换时写入新模型的行，后台全量重算，原子切换，然后**重新标定阈值**（不同模型的余弦尺度不同），见 [embedding-related-classify.md](embedding-related-classify.md) §5。
- **多模态降级**：如果 active embedder 不支持图片，enrich 阶段就生成图片描述并拼进文本。所以表征文本的构造要依赖 `modalities`。
- 存储：`embeddings(item_id, embedder_id, dim, vec, input_hash)`，`input_hash` 包含图片的 hash。

---

## 5. 云端方案的实现要点

| 项 | 做法 |
|---|---|
| 维度 | 768：质量和体积的平衡点；1 万条约 30 MB，内存中暴力搜索即可 |
| 文档输入 | `title: <标题或作者> \| text: <摘要 + 主题 + 备注>`，加上 0–4 张图（推文配图） |
| 首次导入 | 普通接口并发 4–8 路，配合指数退避；如果数量很大且不急，可以走 Batch API（半价，但异步，返回时间不确定） |
| 增量 | 新条目入库后立即 embed；失败的放进重试队列，不阻塞同步 |
| 查询 | `search` 时对查询做 embed，结果缓存（相同查询不重复调用） |
| Key | 和 Decisions API 共用；按 design.md §7 存放在 Keychain，通过 env 注入 MCP |

---

## 6. 用一个下午做对比实验（建议在 P1 做）

Embedding 很便宜，可以直接在你的数据上比较：

```
数据：你的 X 收藏（几百到几千条）+ embedding-related-classify.md §5 的相关度标注集（30 个目标 × 候选 0–3 级）
候选：gemini-embedding-2@768 · EmbeddingGemma q4@768 · Qwen3-0.6B int8@1024 ·（基线）multilingual-e5-small
指标：相关度 nDCG@10 / P@10（只用 embedding 召回，不加精判）；分类质心法准确率；首次导入耗时；内存峰值
额外：图片帖子集单独统计（云端直接 embed 图片 vs 本地用"文字 + 图片描述"）
```

如果本地模型的差距在 2–3 个百分点以内，"离线/隐私模式"就可以放心提供。
