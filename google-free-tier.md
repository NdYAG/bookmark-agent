# 开发阶段使用 Google Free Tier 是否可行

> 2026-11-19。来源：
> - [aistudio.google.com/docs/pricing](https://aistudio.google.com/docs/pricing)
> - [aistudio.google.com/docs/rate-limits](https://aistudio.google.com/docs/rate-limits)
>
> **除 `gemini-decision-1` 外，其他模型的 free tier 限流只能登录 AI Studio 后查看**（aistudio.google.com/rate-limit），我无法读取。下文凡是用到这些限流的地方都写成公式，请你填入实际数值。

---

## 1. 结论

**可行，而且推荐用于开发阶段。** 本项目要用到的四类模型（enrich 用的 LLM、embedding、Decisions、聊天）都有 free tier，一个 Google key 就能覆盖。

但是要知道三点：

1. **Free tier 的数据"可能被用于改进 Google 的产品"**，付费层则不会。开发时用你自己的收藏一般可以接受。**App 分发给其他用户时，要在设置页明确提示**；如果用户填的是 free tier key，也适用同样的条款。
2. **真正的约束是限流，不是费用。** 首次导入几千条时会触发限流，必须有限速队列和缓存（§4）。
3. **转为付费的成本极低**：首次导入 3,000 条大约 **2–3 美元**（§3）。以后转付费的主要理由会是数据政策和限流，而不是省钱。

---

## 2. 相关模型的价格与 free tier

| 用途 | 模型 | Free tier | 付费价格（每 1M token） | 备注 |
|---|---|---|---|---|
| **Embedding** | **`gemini-embedding-2`** | ✅ 输入免费（不支持 batch） | 文本 $0.20；图片 $0.45（约 $0.00012/张）；Batch 半价 | 多模态；本项目默认 |
| Embedding | `gemini-embedding-001` | ✅ 输入免费（不支持 batch） | $0.15；Batch $0.075 | 只支持文本，输入上限 2k token |
| **精判 / 分类** | **`gemini-decision-1`** | ✅ 输入免费；**200 RPM / 50k TPM / 10k RPD** | $0.10（任意模态，无输出费用） | 不支持 batch |
| **Enrich**（便宜的 LLM） | **`gemini-3.1-flash-lite`** | ✅ | 输入 $0.25 / 输出 $1.50 | 推荐的 enrich 模型，见 §2.1 |
| Enrich（备选） | `gemini-3.5-flash-lite` | ✅ | 输入 $0.30 / 输出 $2.50 | 质量更高、更贵 |
| Enrich（备选） | `gemini-2.5-flash-lite` | ✅ | 输入 $0.10 / 输出 $0.40 | 最便宜，但属于旧一代；同代的 `2.5-flash` 已经弃用，12/1 起会被路由到 3.5-flash-lite，**lite 版本也可能随后跟进**，不建议依赖 |
| Enrich（开发期补充） | **Gemma 4** | ✅ 输入、输出均免费 | **没有付费层** | 只能用于开发；它是开放权重模型，也是以后"本地模式"的桥梁 |
| 聊天（agent） | `gemini-3.6-flash` / `gemini-3.8-flash` | ✅ | 输入 $0.75 / 输出 $3.75（2026 年底前；**2027-01-01 起翻倍**） | 开发 agent 时也可以用同一个 key |

### 2.1 Enrich 模型怎么选

Enrich 的任务是：把推文正文、引用推文、链接卡片、图片整理成 `{summary, topics, kind, lang}`，可能还要为图片写一句描述。这是**简单的结构化抽取，不需要强推理**，但需要：
- 中英混合的理解能力
- 能看图（推文配图）
- 支持 JSON 结构化输出

**推荐 `gemini-3.1-flash-lite`**，理由如下：
- **付费价格是当前一代里最低的**，转为付费后不需要换模型。
- **开发期就用生产会用的模型**，避免以后换模型时重调提示词和评测。
- 能处理视觉输入。

需要更好的摘要质量时再升级到 `3.5-flash-lite`。是否值得升级，用 [embedding-related-classify.md](embedding-related-classify.md) §5 的评测集来判断：看相关度和分类的指标有没有提升，而不是凭感觉。

**Gemma 4 的用法**：每个模型的限流是**分开计算**的（限流表按模型列出），所以开发期首次全量 enrich 时，可以把 Gemma 4 作为**溢出通道**：flash-lite 的配额用完后切到 Gemma 4 继续处理。但两者的输出风格会有差异，所以 card 里要记录 `enrich_model`，以后可以用同一个模型统一重跑。不要依赖它进生产，因为它没有付费层。

### 2.2 图片描述还要不要做

`gemini-embedding-2` 能直接 embed 图片，所以**对向量来说，不需要图片描述**。但图片描述仍然有用：
- FTS 全文检索（图片里的内容可以被搜到）
- agent 回答时作为上下文（不必每次都把原图发给聊天模型）

做法：在 enrich 的同一次调用里顺带生成图片描述，不单独发请求。

---

## 3. 成本估算：如果直接用付费层

以首次导入 3,000 条为例。假设一半的条目带图；每条 enrich 输入约 1.5k token（含图片），输出约 150 token。

| 环节 | 用量 | 费用 |
|---|---|---|
| Enrich（3.1-flash-lite） | 4.5M 输入 + 0.45M 输出 | $1.13 + $0.68 ≈ **$1.8** |
| Embedding（embedding-2） | 0.9M 文本 token + 约 1,500 张图 | $0.18 + $0.18 ≈ **$0.36** |
| Decisions 分类（全部 3,000 条，每条约 400 token） | 1.2M | **$0.12**（只处理拿不准的部分会更少） |
| Decisions 精判（每次右键约 6k token） | 1,000 次右键 = 6M | **$0.60** |
| 日常增量（每天 20 条） | — | 约 **$0.01/天** |

**首次导入 ≈ 2.3 美元，之后每月不到 1 美元**（不含聊天模型）。

---

## 4. Free tier 下的限流：怎么估算、怎么设计

### 4.1 估算公式

```
所需时间(分钟) = max( 请求数 / RPM , 总 token / TPM )
所需天数      = 请求数 / RPD            （RPD 在太平洋时间午夜重置）
```

**Decisions API（已知限流：200 RPM / 50k TPM / 10k RPD）：**

| 场景 | 计算 | 结论 |
|---|---|---|
| 右键精判，每次 6k token | 50k TPM ÷ 6k ≈ **每分钟 8 次** | 单个用户完全够用 |
| 首次导入时全量分类，每条 400 token | 50k ÷ 400 = 每分钟 125 条 → 3,000 条约 **24 分钟**；RPD 10k 足够 | 可行 |
| 批量技巧（一次请求处理 30 条） | 请求数变为原来的 1/30，**但 token 总量不变** | free tier 下瓶颈是 **TPM**，批量只能缓解 RPM，**不会更快** |

**Embedding 和 Enrich（限流请到 AI Studio 查看后代入）：**
- Embedding：3,000 条。如果一次请求能放多条内容（SDK 的 `contents` 接受数组），实际请求数取决于计费口径，**文档没有说明多条内容算一次请求还是多次**，请实测。
- Enrich：3,000 次请求（每条一次，可以合并成每次 5–10 条以减少请求数，但要先评测质量是否下降）。
- 如果 RPD 不足以一天跑完，首次导入就会**分几天完成**。这对开发影响不大，但对新用户的首次体验不好，这也是生产环境需要付费层的另一个理由。

### 4.2 限速队列（要按 free tier 设计，付费后同样适用）

```ts
// 每个模型一个令牌桶：限流是按"项目 × 模型"计算的
const limiter = {
  "gemini-embedding-2":    bucket({ rpm: CFG.embed.rpm,  tpm: CFG.embed.tpm,  rpd: CFG.embed.rpd }),
  "gemini-3.1-flash-lite": bucket({ rpm: CFG.enrich.rpm, tpm: CFG.enrich.tpm, rpd: CFG.enrich.rpd }),
  "gemma-4":               bucket({ ... }),          // 开发期的溢出通道
  "gemini-decision-1":     bucket({ rpm: 200, tpm: 50_000, rpd: 10_000 }),
};
// - 发请求前先估算 token 数，扣减令牌；遇到 429 时按 Retry-After 退避，并下调该桶的速率（自适应）
// - RPD 用完：任务暂停到太平洋时间午夜，UI 显示"今日配额已用完，明天继续（已完成 1,800/3,000）"
// - 优先级：用户交互（search 的查询 embed、右键精判）> 增量同步 > 首次导入的后台任务
```

限流的数值放在 MCP 的配置里（例如 `tiers.free` 和 `tiers.paid` 两套预设），用户在设置里选择自己的层级。

---

## 5. 开发期最省配额的做法（最重要）

**开发期消耗配额的主要不是数据量，而是反复重跑**：每改一次提示词、改一个 bug，就重新 enrich 和 embed 一遍。

1. **所有模型调用都做磁盘缓存**：key = `hash(model + prompt_version + input)`。重跑时命中缓存，不消耗配额，结果也确定，方便调试。
2. **开发用的小数据集**：从 X 导出中抽 200 条覆盖各种类型（纯文字、带图、引用推文、带链接、中文、英文）作为 dev set；全量数据只在需要验证规模时才跑。
3. **测试用录制好的响应**：单元测试和 CI 不调用真实 API，用录制好的结果。
4. **版本化**：card 记录 `enrich_model` 和 `prompt_version`；向量记录 `embedder_id`。改提示词后只重跑受影响的条目。
5. **不要**通过创建多个项目来叠加 free tier 配额，这可能违反服务条款。

---

## 6. 其他注意事项

- **数据政策**：free tier 的输入"可能用于改进 Google 产品"，其中包括别人的推文内容和你的私人收藏。开发期一般可以接受；**正式使用或分发时，建议切换到付费层**（成本见 §3），并在设置页说明不同层级的数据政策。
- **地区可用性**：Gemini API 本身有地区限制，在不支持的地区，无论哪个层级都无法访问。请在你的开发环境确认。
- **价格变动**：Flash 系列 2027-01-01 起涨价一倍；`2.5-flash` 已弃用。**使用稳定的模型 id**，模型 id 写在配置里，不要硬编码。
- **Decisions API 只有 v1beta**：接口可能还会变化，要封装在 `decisions/` 模块中。

---

## 7. 推荐的开发期配置

```json
{
  "tier": "free",
  "embedding": { "model": "gemini-embedding-2", "dim": 768 },
  "enrich":    { "model": "gemini-3.1-flash-lite", "overflow": "gemma-4", "promptVersion": "v1" },
  "decisions": { "model": "gemini-decision-1", "rerank": true, "classifyFallback": true },
  "limits":    { "gemini-embedding-2": {"rpm": "<AI Studio>", "tpm": "<AI Studio>", "rpd": "<AI Studio>"},
                 "gemini-3.1-flash-lite": {"rpm": "<AI Studio>", "tpm": "<AI Studio>", "rpd": "<AI Studio>"},
                 "gemini-decision-1": {"rpm": 200, "tpm": 50000, "rpd": 10000} },
  "cache":     { "dir": "~/.cache/collections-mcp/llm", "enabled": true }
}
```

聊天模型（agent）在开发期也可以用同一个 key 调用 `gemini-3.6-flash`。如果要用其他提供方，在 pi-ai 里另外配置即可。
