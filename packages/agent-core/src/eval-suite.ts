import {
  type AgentMessage,
  BookmarkAgent,
  type LlmFunctionCall,
  type LlmProvider,
  type LlmTurnInput,
  type LlmTurnOutput,
} from "./index.js";

export type EvalCategory =
  | "single_deep_dive"
  | "multi_compare"
  | "theme_review"
  | "why_related"
  | "text_only_negative";

export interface ConversationEvalScenario {
  id: string;
  category: EvalCategory;
  description: string;
  userMessage: AgentMessage;
  expectTools: string[];
  expectA2ui: boolean;
  expectedComponentTypes?: string[];
  expectedCitedIds?: string[];
  /**
   * Deterministic scripted LLM turns for reproducible CI evaluation,
   * while also supporting live Gemini evaluation when `useLiveLlm=true`.
   */
  scriptedTurns: Array<{
    functionCalls?: LlmFunctionCall[];
    text: string;
  }>;
}

/**
 * 20 representative conversation scenarios covering all 5 evaluation categories:
 * - 单条深挖 (single_deep_dive, 4 scenarios)
 * - 多条比较 (multi_compare, 4 scenarios)
 * - 主题回顾 (theme_review, 4 scenarios)
 * - "为什么相关" (why_related, 4 scenarios)
 * - 应当只回文字的反例 (text_only_negative, 4 scenarios — MUST NOT overuse UI!)
 */
export const A1_CONVERSATION_SCENARIOS: ConversationEvalScenario[] = [
  // =========================================================================
  // 1. 单条深挖 (single_deep_dive: 4 scenarios)
  // =========================================================================
  {
    id: "S01_deep_dive_webgpu",
    category: "single_deep_dive",
    description: "深挖 WebGPU 120fps 渲染 5000 个声明式界面的收藏条目",
    userMessage: {
      role: "user",
      type: "text",
      text: "帮我深挖一下我收藏的那条用 WebGPU canvas 在 120fps 下渲染 5000 个 UI 帧的推文（x:1000000000000000008），它核心解决了什么问题？",
    },
    expectTools: ["read_item"],
    expectA2ui: true,
    expectedComponentTypes: ["CollectionCard"],
    expectedCitedIds: ["x:1000000000000000008"],
    scriptedTurns: [
      {
        functionCalls: [{ name: "read_item", args: { id: "x:1000000000000000008" } }],
        text: "",
      },
      {
        text: `这条由 @gpu_craft 发布的收藏展示了基于 WebGPU Canvas 直接渲染大规模声明式界面的方案：在同屏渲染约 5,000 个交互式 UI 帧、超过 100 万个图元时仍能保持 120 fps，突破了传统 DOM 树在大规模节点下的布局与重绘瓶颈。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "CollectionCard",
      "props": {
        "id": "x:1000000000000000008",
        "highlight": "WebGPU Canvas 渲染 5,000 个 UI 帧（120fps）",
        "signals": ["单条深挖", "WebGPU 渲染"]
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S02_deep_dive_procrastination",
    category: "single_deep_dive",
    description: "深挖拆解具体动作细节以克服拖延的收藏长文",
    userMessage: {
      role: "user",
      type: "text",
      text: "我收藏过一条关于把下一步动作拆解到具体细节来克服拖延、提升执行力的内容，帮我读取全文并总结核心做法。",
    },
    expectTools: ["search", "read_item"],
    expectA2ui: true,
    expectedComponentTypes: ["CollectionCard"],
    expectedCitedIds: ["x:1000000000000000028"],
    scriptedTurns: [
      {
        functionCalls: [{ name: "search", args: { query: "克服拖延 执行力" } }],
        text: "",
      },
      {
        functionCalls: [{ name: "read_item", args: { id: "x:1000000000000000028" } }],
        text: "",
      },
      {
        text: `根据你收藏的 @indie_notes 长文内容，克服拖延的核心步骤是：不要停留在抽象的抗拒感里，而是把宏大目标翻译成可执行、无歧义的五分钟微小动作，并在脑海里清晰预演完第一步的具体操作细节，以此降低启动阻力并建立正反馈循环。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "CollectionCard",
      "props": {
        "id": "x:1000000000000000028",
        "highlight": "把宏大目标拆解为可预演的五分钟微小动作，打破拖延"
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S03_deep_dive_plugins",
    category: "single_deep_dive",
    description: "深挖梳理 40+ 开发者效率插件与任务看板工作流的长文收藏",
    userMessage: {
      role: "user",
      type: "text",
      text: "详细解读我收藏的 x:1000000000000000031 这篇关于 40+ 开发者效率插件和任务看板的长文讲了什么。",
    },
    expectTools: ["read_item"],
    expectA2ui: true,
    expectedComponentTypes: ["CollectionCard"],
    expectedCitedIds: ["x:1000000000000000031"],
    scriptedTurns: [
      {
        functionCalls: [{ name: "read_item", args: { id: "x:1000000000000000031" } }],
        text: "",
      },
      {
        text: `这篇由 @plugin_ops 撰写的长文梳理了 40+ 高频开发者效率插件，核心围绕「单插件专注单一职责」展开：用任务看板切分目标、用代码审查 Skill 把关质量，并用上下文监控工具及时清理冗余状态。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "CollectionCard",
      "props": {
        "id": "x:1000000000000000031",
        "highlight": "精选 40+ 效率插件：任务看板、代码审查与上下文流水线"
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S04_deep_dive_three_trees",
    category: "single_deep_dive",
    description: "深挖 Three.js 程序化 3D 树木生成工具收藏",
    userMessage: {
      role: "user",
      type: "text",
      text: "看看我收藏的 x:1000000000000000011（Three.js 程序化树木生成器）具体有什么特性？",
    },
    expectTools: ["read_item"],
    expectA2ui: true,
    expectedComponentTypes: ["CollectionCard"],
    expectedCitedIds: ["x:1000000000000000011"],
    scriptedTurns: [
      {
        functionCalls: [{ name: "read_item", args: { id: "x:1000000000000000011" } }],
        text: "",
      },
      {
        text: `这条由 @three_lab 发布的收藏介绍了基于 Three.js 的程序化 3D 树木几何体生成方案，支持直接参数化调节树干曲率、递归分枝与树冠叶簇分布，并导出轻量化的 glTF 模型资产。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "CollectionCard",
      "props": {
        "id": "x:1000000000000000011",
        "highlight": "Three.js 参数化生成 3D 树木网格并支持 glTF 导出"
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },

  // =========================================================================
  // 2. 多条比较 (multi_compare: 4 scenarios)
  // =========================================================================
  {
    id: "S05_compare_gpu_ui_approaches",
    category: "multi_compare",
    description: "对比用户在 Grid 中选中的两条 GPU UI 渲染收藏（WebGPU Canvas vs Rust GPUI）",
    userMessage: {
      role: "user",
      type: "attached_items",
      items: [
        {
          id: "x:1000000000000000008",
          author: "@gpu_craft",
          excerpt: "WebGPU Canvas Rendering 5,000 Declarative UI Frames at 120fps",
        },
        {
          id: "x:1000000000000000015",
          author: "@rust_sys",
          excerpt: "Rust GPUI Desktop Component Architecture: Zero-Copy Layouts",
        },
      ],
      prompt: "对比这两条收藏的 GPU UI 渲染路线有什么异同？",
    },
    expectTools: ["get_items"],
    expectA2ui: true,
    expectedComponentTypes: ["ThemeCompare"],
    expectedCitedIds: ["x:1000000000000000008", "x:1000000000000000015"],
    scriptedTurns: [
      {
        functionCalls: [
          {
            name: "get_items",
            args: { ids: ["x:1000000000000000008", "x:1000000000000000015"] },
          },
        ],
        text: "",
      },
      {
        text: `这两条收藏代表了高性能 GPU 加速 UI 的两条不同技术路径：前者是在浏览器内通过 WebGPU Canvas 直接接管大规模声明式帧渲染；后者则是基于 Rust 原生 GPUI 框架在 Metal/Vulkan 上构建低内存桌面组件库。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ThemeCompare",
      "props": {
        "title": "WebGPU Canvas 渲染 vs Rust GPUI 原生路线对比",
        "dimensions": ["运行时环境", "核心优势"],
        "columns": [
          {
            "theme": "Web 端 WebGPU Canvas 渲染",
            "summary": "在浏览器内用 WebGPU 渲染 5,000 个 UI 帧达 120fps",
            "pros": ["保留 Web 跨端分发能力", "突破传统 DOM 数量上限"],
            "cons": ["依赖浏览器 WebGPU 支持"],
            "itemIds": ["x:1000000000000000008"]
          },
          {
            "theme": "原生 Rust GPUI 组件库",
            "summary": "基于 Metal/Vulkan 打造的零拷贝桌面端 UI 组件架构",
            "pros": ["闲置内存低于 40MB", "原生低延迟与强类型安全"],
            "cons": ["需独立编译桌面端应用"],
            "itemIds": ["x:1000000000000000015"]
          }
        ]
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S06_compare_3d_tree_tools",
    category: "multi_compare",
    description: "对比收藏中的 3D 植物/树木建模方案",
    userMessage: {
      role: "user",
      type: "text",
      text: "对比我收藏的 Three.js 程序化树木 (x:1000000000000000011)、2D Billboard 植物方案 (x:1000000000000000012) 和 Blender 几何节点植被导出 (x:1000000000000000014)。",
    },
    expectTools: ["get_items"],
    expectA2ui: true,
    expectedComponentTypes: ["ThemeCompare"],
    expectedCitedIds: [
      "x:1000000000000000011",
      "x:1000000000000000012",
      "x:1000000000000000014",
    ],
    scriptedTurns: [
      {
        functionCalls: [
          {
            name: "get_items",
            args: {
              ids: [
                "x:1000000000000000011",
                "x:1000000000000000012",
                "x:1000000000000000014",
              ],
            },
          },
        ],
        text: "",
      },
      {
        text: `这三条收藏分别覆盖了 Web 端程序化几何建模、实时 2D Billboard 风格化植物，以及 DCC 工具（Blender Geometry Nodes）离线生成后压缩导出三种方案：

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ThemeCompare",
      "props": {
        "title": "三种 3D 植物与树木建模方案对比",
        "columns": [
          {
            "theme": "Web 程序化 3D 树 (Three.js)",
            "summary": "在浏览器端实时参数化生成树干与树冠网格并导出 glTF",
            "itemIds": ["x:1000000000000000011"]
          },
          {
            "theme": "2D Billboard 朝向相机方案",
            "summary": "每颗果实与枝叶均为面向相机的 2D billboard，兼具手绘感与极低面数",
            "itemIds": ["x:1000000000000000012"]
          },
          {
            "theme": "Blender Geometry Nodes 管线",
            "summary": "离线程序生成树冠并将实例属性压缩导出至 WebGL",
            "itemIds": ["x:1000000000000000014"]
          }
        ]
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S07_compare_html_in_canvas_libs",
    category: "multi_compare",
    description: "对比 Canvas 组件库与 WebGPU 混合面板收藏",
    userMessage: {
      role: "user",
      type: "attached_items",
      items: [
        { id: "x:1000000000000000009", author: "@canvas_ui", excerpt: "Introducing CanvasBox: HTML-in-Canvas Component Primitives" },
        { id: "xhs:600000000000000000000006", author: "前端视觉志", excerpt: "Canvas 2D 与 WebGPU 混合渲染交互面板对比" },
      ],
      prompt: "比较这两条关于 Canvas UI 渲染的收藏分别展示了什么？",
    },
    expectTools: ["get_items"],
    expectA2ui: true,
    expectedComponentTypes: ["ThemeCompare"],
    expectedCitedIds: ["x:1000000000000000009", "xhs:600000000000000000000006"],
    scriptedTurns: [
      {
        functionCalls: [
          {
            name: "get_items",
            args: { ids: ["x:1000000000000000009", "xhs:600000000000000000000006"] },
          },
        ],
        text: "",
      },
      {
        text: `@canvas_ui 的收藏聚焦于将声明式布局与 GPU 管线打通的组件基元（CanvasBox），而小红书「前端视觉志」则从实战基准角度对比了 Canvas 2D 与 WebGPU 在高密度节点画布下的帧率稳定性和内存表现。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ThemeCompare",
      "props": {
        "title": "HTML-in-Canvas 组件抽象 vs 渲染后端性能对比",
        "columns": [
          {
            "theme": "CanvasBox 组件原语",
            "summary": "封装可组合的 HTML-in-Canvas 声明式组件能力",
            "itemIds": ["x:1000000000000000009"]
          },
          {
            "theme": "Canvas 2D 与 WebGPU 实测对比",
            "summary": "对比高密度交互面板在不同后端下的帧率稳定性与内存开销",
            "itemIds": ["xhs:600000000000000000000006"]
          }
        ]
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S08_compare_llm_evals_and_context",
    category: "multi_compare",
    description: "对比 Agent Evals 评测与长上下文压缩策略收藏",
    userMessage: {
      role: "user",
      type: "text",
      text: "对比我收藏里关于 Agent Evals 评测 (x:1000000000000000002, x:1000000000000000005) 与上下文反编译压缩 (x:1000000000000000004) 的侧重点。",
    },
    expectTools: ["get_items"],
    expectA2ui: true,
    expectedComponentTypes: ["ThemeCompare"],
    expectedCitedIds: [
      "x:1000000000000000002",
      "x:1000000000000000005",
      "x:1000000000000000004",
    ],
    scriptedTurns: [
      {
        functionCalls: [
          {
            name: "get_items",
            args: {
              ids: [
                "x:1000000000000000002",
                "x:1000000000000000005",
                "x:1000000000000000004",
              ],
            },
          },
        ],
        text: "",
      },
      {
        text: `这两组收藏分别从「离线回归质量门禁（Evals）」和「多轮界面上下文 Token 控制」两个维度切入 Agent 工程化：

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ThemeCompare",
      "props": {
        "title": "Agent Evals 评测体系 vs 上下文压缩策略",
        "columns": [
          {
            "theme": "脚本化 Evals 与 CI 回归",
            "summary": "检验工具调用准确率、UI 编译率与 ID 真实性并纳入 CI",
            "itemIds": ["x:1000000000000000002", "x:1000000000000000005"]
          },
          {
            "theme": "多轮 Surface 反编译与折叠",
            "summary": "仅展开当前活跃 Surface 为 Express 语法，历史轮次摘要折叠",
            "itemIds": ["x:1000000000000000004"]
          }
        ]
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },

  // =========================================================================
  // 3. 主题回顾 (theme_review: 4 scenarios)
  // =========================================================================
  {
    id: "S09_theme_review_webgpu",
    category: "theme_review",
    description: "回顾收藏过的所有 WebGPU 与着色器相关推文",
    userMessage: {
      role: "user",
      type: "text",
      text: "帮我回顾一下我收藏过哪些关于 WebGPU 和 Shader 特效的内容？",
    },
    expectTools: ["search"],
    expectA2ui: true,
    expectedComponentTypes: ["ItemGrid"],
    expectedCitedIds: ["x:1000000000000000008", "x:1000000000000000010"],
    scriptedTurns: [
      {
        functionCalls: [{ name: "search", args: { query: "WebGPU" } }],
        text: "",
      },
      {
        text: `你在收藏库中重点关注了 WebGPU 高性能界面渲染与 WGSL 开源着色器特效库，代表性条目如下：

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ItemGrid",
      "props": {
        "title": "WebGPU 与 Shader 相关收藏回顾",
        "ids": ["x:1000000000000000008", "x:1000000000000000010"],
        "notes": {
          "x:1000000000000000008": "WebGPU 120fps 渲染 5,000 个 UI 帧",
          "x:1000000000000000010": "开源 200+ WebGPU 与 WGSL 特效集"
        }
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S10_theme_review_plugins_workflow",
    category: "theme_review",
    description: "回顾关于插件化与开发者工作流的收藏并梳理演进脉络",
    userMessage: {
      role: "user",
      type: "text",
      text: "梳理一下我收藏过的关于开发者效率插件与任务看板工作流的演进脉络。",
    },
    expectTools: ["search"],
    expectA2ui: true,
    expectedComponentTypes: ["Timeline"],
    expectedCitedIds: [
      "x:1000000000000000032",
      "xhs:600000000000000000000014",
      "x:1000000000000000031",
    ],
    scriptedTurns: [
      {
        functionCalls: [{ name: "search", args: { query: "插件" } }],
        text: "",
      },
      {
        text: `从你的收藏脉络来看，你从单一的代码审查与上下文监控插件出发，逐步结合任务看板拆解行动单元，沉淀出完整的 40+ 效率插件工作流体系：

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "Timeline",
      "props": {
        "title": "开发者效率插件与工作流收藏脉络",
        "steps": [
          {
            "label": "阶段一：编码循环与看板拆分",
            "takeaway": "引入上下文检查、自动 Code Review 与最小行动单元看板",
            "itemIds": ["x:1000000000000000032", "xhs:600000000000000000000014"]
          },
          {
            "label": "阶段二：插件化生态全景梳理",
            "takeaway": "汇总 40+ 专注单一职责的开发者效率插件清单",
            "itemIds": ["x:1000000000000000031"]
          }
        ]
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S11_theme_review_self_improvement",
    category: "theme_review",
    description: "回顾个人成长、克服拖延与找回行动力的收藏",
    userMessage: {
      role: "user",
      type: "text",
      text: "汇总一下我收藏的关于克服拖延、找回执行力和心态调整的内容。",
    },
    expectTools: ["search"],
    expectA2ui: true,
    expectedComponentTypes: ["ItemGrid"],
    expectedCitedIds: [
      "x:1000000000000000028",
      "x:1000000000000000029",
      "x:1000000000000000030",
      "x:1000000000000000034",
    ],
    scriptedTurns: [
      {
        functionCalls: [{ name: "search", args: { query: "克服拖延 个人成长" } }],
        text: "",
      },
      {
        text: `你在个人成长与行动力方向共收藏了 4 条互补的内容，覆盖从具体微行动预演、每日 1% 复利推进到心态重塑：

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ItemGrid",
      "props": {
        "title": "克服拖延与行动力提升收藏合集",
        "ids": [
          "x:1000000000000000028",
          "x:1000000000000000029",
          "x:1000000000000000030",
          "x:1000000000000000034"
        ],
        "notes": {
          "x:1000000000000000028": "细节预演：用五分钟具体微动作打破任务瘫痪",
          "x:1000000000000000029": "复利原则：每天推进 1% 稳定交付独立产品",
          "x:1000000000000000030": "聚焦重置：用一天复盘梳理每日核心检查点",
          "x:1000000000000000034": "缓解焦虑：用小型可复现 Demo 替代心理内耗"
        }
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S12_theme_review_threejs_effects",
    category: "theme_review",
    description: "回顾 Three.js 与 3D 视觉特效收藏",
    userMessage: {
      role: "user",
      type: "text",
      text: "我收藏了哪些跟 Three.js 相关的 3D 工具或粒子特效教程？",
    },
    expectTools: ["search"],
    expectA2ui: true,
    expectedComponentTypes: ["ItemGrid"],
    expectedCitedIds: ["x:1000000000000000011", "x:1000000000000000013"],
    scriptedTurns: [
      {
        functionCalls: [{ name: "search", args: { query: "Three.js" } }],
        text: "",
      },
      {
        text: `你收藏了以下与 Three.js 建模和粒子特效直接相关的条目：

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ItemGrid",
      "props": {
        "title": "Three.js 工具与特效收藏",
        "ids": ["x:1000000000000000011", "x:1000000000000000013"],
        "notes": {
          "x:1000000000000000011": "参数化程序生成 3D 树木模型并导出 glTF",
          "x:1000000000000000013": "Three.js + TSL 计算着色器驱动 30 万 GPU 粒子"
        }
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },

  // =========================================================================
  // 4. "为什么相关" (why_related: 4 scenarios)
  // =========================================================================
  {
    id: "S13_why_related_webgpu_and_canvas_ui",
    category: "why_related",
    description: "解释为什么 WebGPU 5000 帧渲染推文与 CanvasBox / 混合渲染面板相关",
    userMessage: {
      role: "user",
      type: "attached_items",
      items: [
        { id: "x:1000000000000000008", author: "@gpu_craft", excerpt: "WebGPU Canvas Rendering 5,000 Declarative UI Frames at 120fps" },
        { id: "x:1000000000000000009", author: "@canvas_ui", excerpt: "Introducing CanvasBox: HTML-in-Canvas Component Primitives" },
        { id: "xhs:600000000000000000000006", author: "前端视觉志", excerpt: "Canvas 2D 与 WebGPU 混合渲染交互面板对比" },
      ],
      prompt: "这三条收藏为什么相关？它们合起来说明了什么趋势？",
    },
    expectTools: ["get_items"],
    expectA2ui: true,
    expectedComponentTypes: ["ItemGrid"],
    expectedCitedIds: [
      "x:1000000000000000008",
      "x:1000000000000000009",
      "xhs:600000000000000000000006",
    ],
    scriptedTurns: [
      {
        functionCalls: [
          {
            name: "get_items",
            args: {
              ids: [
                "x:1000000000000000008",
                "x:1000000000000000009",
                "xhs:600000000000000000000006",
              ],
            },
          },
        ],
        text: "",
      },
      {
        text: `这三条跨平台收藏共同指向了 **HTML-in-Canvas 与 WebGPU 高密度交互界面融合** 的技术趋势：@gpu_craft 验证了 WebGPU Canvas 渲染数千帧 UI 的极限帧率上限，@canvas_ui 封装出了声明式组件基元，而小红书「前端视觉志」补充了 Canvas 2D 与 WebGPU 后端的实测对比基准。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ItemGrid",
      "props": {
        "title": "HTML-in-Canvas 与 WebGPU 关联收藏",
        "ids": [
          "x:1000000000000000008",
          "x:1000000000000000009",
          "xhs:600000000000000000000006"
        ],
        "notes": {
          "x:1000000000000000008": "性能极限：WebGPU Canvas 120fps 渲染 5,000 UI 帧",
          "x:1000000000000000009": "组件生态：CanvasBox HTML-in-Canvas 原语库",
          "xhs:600000000000000000000006": "实战基准：Canvas 2D 与 WebGPU 面板帧率内存对比"
        }
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S14_why_related_cross_lingual_trees",
    category: "why_related",
    description: "解释英文 Three.js 树木生成器与中文 2D billboard 植物方案为什么相关",
    userMessage: {
      role: "user",
      type: "attached_items",
      items: [
        { id: "x:1000000000000000011", author: "@three_lab", excerpt: "Procedural 3D Tree Geometry Generator in Three.js" },
        { id: "x:1000000000000000012", author: "@flora_3d", excerpt: "实时 3D 场景中的 2D Billboard 植物朝向相机渲染技巧" },
      ],
      prompt: "为什么这两条一中一英的收藏会被关联在一起？",
    },
    expectTools: ["get_items"],
    expectA2ui: true,
    expectedComponentTypes: ["ItemGrid"],
    expectedCitedIds: ["x:1000000000000000011", "x:1000000000000000012"],
    scriptedTurns: [
      {
        functionCalls: [
          {
            name: "get_items",
            args: { ids: ["x:1000000000000000011", "x:1000000000000000012"] },
          },
        ],
        text: "",
      },
      {
        text: `虽然两条推文分别使用英文和中文，但它们都在解决**实时 3D 场景中的植被高效建模与渲染**问题：@three_lab 通过参数化生成完整 3D 树干与树冠几何体，而 @flora_3d 则用面向相机的 2D billboard 实现极低面数风格化植被，两者在写实与风格化管线中互为补充。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ItemGrid",
      "props": {
        "title": "跨语言关联：3D 树木与植物建模方案",
        "ids": ["x:1000000000000000011", "x:1000000000000000012"],
        "notes": {
          "x:1000000000000000011": "英文：Three.js 参数化 3D 树木几何生成",
          "x:1000000000000000012": "中文：2D Billboard 朝向相机的风格化植物渲染"
        }
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S15_why_related_action_frameworks",
    category: "why_related",
    description: "解释微观动作预演与一日聚焦重置框架为什么相关",
    userMessage: {
      role: "user",
      type: "attached_items",
      items: [
        { id: "x:1000000000000000028", author: "@indie_notes", excerpt: "把下一步动作拆解到具体操作细节，刺激行动力启动" },
        { id: "x:1000000000000000030", author: "@indie_notes", excerpt: "A One-Day Focus Reset Framework: Turning Long-Term Goals into Daily Sprints" },
      ],
      prompt: "这两条收藏有什么内在联系？",
    },
    expectTools: ["get_items"],
    expectA2ui: true,
    expectedComponentTypes: ["ItemGrid"],
    expectedCitedIds: ["x:1000000000000000028", "x:1000000000000000030"],
    scriptedTurns: [
      {
        functionCalls: [
          {
            name: "get_items",
            args: { ids: ["x:1000000000000000028", "x:1000000000000000030"] },
          },
        ],
        text: "",
      },
      {
        text: `这两条收藏分别从**微观即时启动**和**宏观周期重置**探讨如何打破拖延：前者聚焦在当下抗拒行动时如何用五分钟细节预演降低阻力；后者则通过一天深度复盘把长期目标收敛为每日三条不可妥协的检查点。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ItemGrid",
      "props": {
        "title": "微观行动启动与宏观目标重置",
        "ids": ["x:1000000000000000028", "x:1000000000000000030"],
        "notes": {
          "x:1000000000000000028": "微观启动：预演五分钟具体操作细节打破拖延",
          "x:1000000000000000030": "宏观重置：用一日深度复盘重构每日冲刺检查点"
        }
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },
  {
    id: "S16_why_related_plugin_workflows",
    category: "why_related",
    description: "解释 40+ 插件全景清单与日常代码审查插件推文的关联",
    userMessage: {
      role: "user",
      type: "attached_items",
      items: [
        { id: "x:1000000000000000031", author: "@plugin_ops", excerpt: "Curating 40+ Developer Productivity Plugins & Taskboard Workflows" },
        { id: "x:1000000000000000032", author: "@plugin_ops", excerpt: "Context Inspection & Automated Code Review Plugins in Daily Dev Loops" },
      ],
      prompt: "分析这两条关于效率插件的收藏为什么高度相关。",
    },
    expectTools: ["get_items"],
    expectA2ui: true,
    expectedComponentTypes: ["ItemGrid"],
    expectedCitedIds: ["x:1000000000000000031", "x:1000000000000000032"],
    scriptedTurns: [
      {
        functionCalls: [
          {
            name: "get_items",
            args: { ids: ["x:1000000000000000031", "x:1000000000000000032"] },
          },
        ],
        text: "",
      },
      {
        text: `这两条收藏同属开发者插件化工作流主题：前一条提供了覆盖任务看板与自动化的 40+ 工具全景清单，后一条则深入拆解其中上下文检查与自动 Code Review 插件在日常开发闭环中的联动方式。

\`\`\`a2ui
{
  "surfaceId": "main",
  "components": [
    {
      "component": "ItemGrid",
      "props": {
        "title": "插件生态全景与编码闭环实战",
        "ids": ["x:1000000000000000031", "x:1000000000000000032"],
        "notes": {
          "x:1000000000000000031": "全景清单：40+ 开发者效率与任务看板插件",
          "x:1000000000000000032": "单点深入：上下文检查与自动代码审查日常闭环"
        }
      }
    }
  ]
}
\`\`\``,
      },
    ],
  },

  // =========================================================================
  // 5. 应当只回文字的反例 (text_only_negative: 4 scenarios — MUST NOT output A2UI!)
  // =========================================================================
  {
    id: "S17_negative_greeting",
    category: "text_only_negative",
    description: "简单打招呼与询问功能（反例：不该输出 A2UI）",
    userMessage: {
      role: "user",
      type: "text",
      text: "你好！请问你可以帮我做什么？",
    },
    expectTools: [],
    expectA2ui: false,
    scriptedTurns: [
      {
        text: "你好！我是你的个人收藏管理 Agent。我可以帮你在多平台收藏库中检索内容、深挖单条帖子或外链全文、对比多条同主题收藏，以及梳理各领域的收藏脉络。",
      },
    ],
  },
  {
    id: "S18_negative_simple_count",
    category: "text_only_negative",
    description: "简单数字统计提问（反例：只需要一句文字回答总条数，不应滥用卡片 UI）",
    userMessage: {
      role: "user",
      type: "text",
      text: "我目前一共收藏了多少条内容？直接告诉我数字就行。",
    },
    expectTools: ["stats"],
    expectA2ui: false,
    scriptedTurns: [
      {
        functionCalls: [{ name: "stats", args: {} }],
        text: "",
      },
      {
        text: "你目前的收藏库中一共有 **60 条**有效收藏（X 40 条，小红书 20 条）。",
      },
    ],
  },
  {
    id: "S19_negative_uncollected_topic",
    category: "text_only_negative",
    description: "询问收藏库中完全不存在的主题（反例：检索为空时应如实文字说明，绝不能编造卡片）",
    userMessage: {
      role: "user",
      type: "text",
      text: "我有没有收藏过关于「量子拓扑超导芯片制造」的内容？",
    },
    expectTools: ["search"],
    expectA2ui: false,
    scriptedTurns: [
      {
        functionCalls: [{ name: "search", args: { query: "量子拓扑超导芯片" } }],
        text: "",
      },
      {
        text: "我在你的收藏库中没有检索到任何关于「量子拓扑超导芯片制造」的收藏。如果你需要了解该领域的通用背景知识，我可以为你补充说明。",
      },
    ],
  },
  {
    id: "S20_negative_write_cancelled",
    category: "text_only_negative",
    description: "未开启写操作确认时请求删除收藏（反例：被 beforeToolCall 拦截后应纯文本礼貌说明）",
    userMessage: {
      role: "user",
      type: "text",
      text: "帮我删掉 x:1000000000000000002 这条收藏。",
    },
    expectTools: ["remove"],
    expectA2ui: false,
    scriptedTurns: [
      {
        functionCalls: [{ name: "remove", args: { id: "x:1000000000000000002" } }],
        text: "",
      },
      {
        text: "删除操作（`remove`）属于写操作，当前未获得你的确认授权，因此我没有删除 `x:1000000000000000002`。请在确认开启写操作权限后再试。",
      },
    ],
  },
];

/**
 * Creates a deterministic LlmProvider from a scenario's `scriptedTurns`.
 */
export function createScriptedLlmProvider(
  turns: ConversationEvalScenario["scriptedTurns"],
): LlmProvider {
  let cursor = 0;
  return {
    modelId: "scripted-eval-provider",
    async generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput> {
      const t0 = Date.now();
      const step = turns[Math.min(cursor, turns.length - 1)] || { text: "" };
      cursor++;
      if (step.text && input.onTextDelta) {
        const chunkSize = 32;
        for (let i = 0; i < step.text.length; i += chunkSize) {
          input.onTextDelta(step.text.slice(i, i + chunkSize));
        }
      }
      const elapsed = Math.max(1, Date.now() - t0);
      return {
        text: step.text || "",
        functionCalls: step.functionCalls || [],
        firstTokenLatencyMs: elapsed,
        totalLatencyMs: elapsed,
      };
    },
  };
}

export interface ScenarioEvalResult {
  scenarioId: string;
  category: EvalCategory;
  toolCallAccurate: boolean;
  calledTools: string[];
  expectedTools: string[];
  a2uiCompilePassed: boolean;
  hasA2uiSurface: boolean;
  expectA2ui: boolean;
  noUiOveruseOnNegative: boolean;
  allCitedIdsExist: boolean;
  citedIds: string[];
  missingIds: string[];
  judgeScore: number;
  firstTokenLatencyMs: number;
  firstPaintLatencyMs: number;
  totalLatencyMs: number;
}

export interface ConversationEvalSummary {
  totalScenarios: number;
  toolCallAccuracyRate: number;
  a2uiCompilePassRate: number;
  negativeNoUiOveruseRate: number;
  citedIdsExistRate: number;
  averageJudgeScore: number;
  avgFirstTokenLatencyMs: number;
  avgFirstPaintLatencyMs: number;
  results: ScenarioEvalResult[];
}

function computeJudgeScore(params: {
  toolCallAccurate: boolean;
  a2uiCompilePassed: boolean;
  noUiOveruseOnNegative: boolean;
  allCitedIdsExist: boolean;
  textLength: number;
}): number {
  let score = 5;
  if (!params.toolCallAccurate) score -= 1.5;
  if (!params.a2uiCompilePassed) score -= 1.5;
  if (!params.noUiOveruseOnNegative) score -= 2.0;
  if (!params.allCitedIdsExist) score -= 2.0;
  if (params.textLength < 15) score -= 0.5;
  return Math.max(1, Number(score.toFixed(2)));
}

/**
 * Runs the 20-scenario A1 conversation evaluation suite and computes all pass criteria:
 * - A2UI compile pass rate >= 95%
 * - 0 UI overuse on text-only negative scenarios
 * - 100% of cited bookmark IDs exist in `collections.db`
 */
export async function runA1ConversationEval(opts: {
  createAgentForScenario: (scenario: ConversationEvalScenario) => Promise<{
    agent: BookmarkAgent;
    verifyIdsExist: (ids: string[]) => Promise<string[]>;
    cleanup?: () => Promise<void>;
  }>;
  scenarios?: ConversationEvalScenario[];
}): Promise<ConversationEvalSummary> {
  const scenarios = opts.scenarios || A1_CONVERSATION_SCENARIOS;
  const results: ScenarioEvalResult[] = [];

  for (const sc of scenarios) {
    const { agent, verifyIdsExist, cleanup } = await opts.createAgentForScenario(sc);
    try {
      const turnRes = await agent.runTurn(`eval-${sc.id}`, sc.userMessage);
      const calledTools = turnRes.toolCalls.map((t) => t.name);

      const toolCallAccurate = sc.expectTools.every((expected) =>
        calledTools.includes(expected),
      );

      const hasA2uiSurface = turnRes.surfaces.length > 0;
      const a2uiCompilePassed = sc.expectA2ui
        ? turnRes.metrics.compileSuccess && hasA2uiSurface
        : turnRes.metrics.compileSuccess;

      const noUiOveruseOnNegative =
        sc.category === "text_only_negative" ? !hasA2uiSurface : true;

      const citedIds = turnRes.message.referencedIds || [];
      const missingIds = citedIds.length > 0 ? await verifyIdsExist(citedIds) : [];
      const allCitedIdsExist = missingIds.length === 0;

      const judgeScore = computeJudgeScore({
        toolCallAccurate,
        a2uiCompilePassed,
        noUiOveruseOnNegative,
        allCitedIdsExist,
        textLength: (turnRes.message.text || "").length,
      });

      results.push({
        scenarioId: sc.id,
        category: sc.category,
        toolCallAccurate,
        calledTools,
        expectedTools: sc.expectTools,
        a2uiCompilePassed,
        hasA2uiSurface,
        expectA2ui: sc.expectA2ui,
        noUiOveruseOnNegative,
        allCitedIdsExist,
        citedIds,
        missingIds,
        judgeScore,
        firstTokenLatencyMs: turnRes.metrics.firstTokenLatencyMs,
        firstPaintLatencyMs: turnRes.metrics.firstPaintLatencyMs,
        totalLatencyMs: turnRes.metrics.totalLatencyMs,
      });
    } finally {
      if (cleanup) await cleanup();
    }
  }

  const total = results.length;
  const toolAccCount = results.filter((r) => r.toolCallAccurate).length;
  const compilePassCount = results.filter((r) => r.a2uiCompilePassed).length;
  const negativeScenarios = results.filter((r) => r.category === "text_only_negative");
  const negativePassCount = negativeScenarios.filter((r) => r.noUiOveruseOnNegative).length;
  const idExistCount = results.filter((r) => r.allCitedIdsExist).length;

  const avgJudge =
    results.reduce((acc, r) => acc + r.judgeScore, 0) / Math.max(1, total);
  const avgFirstToken =
    results.reduce((acc, r) => acc + r.firstTokenLatencyMs, 0) / Math.max(1, total);
  const avgFirstPaint =
    results.reduce((acc, r) => acc + r.firstPaintLatencyMs, 0) / Math.max(1, total);

  return {
    totalScenarios: total,
    toolCallAccuracyRate: toolAccCount / Math.max(1, total),
    a2uiCompilePassRate: compilePassCount / Math.max(1, total),
    negativeNoUiOveruseRate:
      negativePassCount / Math.max(1, negativeScenarios.length),
    citedIdsExistRate: idExistCount / Math.max(1, total),
    averageJudgeScore: Number(avgJudge.toFixed(2)),
    avgFirstTokenLatencyMs: Number(avgFirstToken.toFixed(1)),
    avgFirstPaintLatencyMs: Number(avgFirstPaint.toFixed(1)),
    results,
  };
}
