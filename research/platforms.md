# 商业平台案例调研笔记（子任务：调研商业平台案例）

> 调研时间：2026-09-02（以页面抓取当日为准）
> 方法：web_search + read_web_page。所有"事实"均标注来源 URL；"推断"为基于事实的合理外推，与事实明确区分。
> 证据缺口：火山方舟仅有搜索结果摘要（未成功读取页面正文）；阿里云百炼因页面访问失败未完成调研；各平台均未在公开定价页披露可引用的 P50/P99 延迟与吞吐数据。

---

## 1. OpenRouter（聚合网关型）

**定位**：纯聚合/中转层，单一 API 接入数百个模型（官方表述 "One API for hundreds of models"）。

### 事实（来源：https://openrouter.ai/ 首页、https://openrouter.ai/docs/llms.txt 文档索引）
- 提供三种集成方式：直接 API（全控制、任意语言、无依赖）、Client SDK（类型安全模型调用）、Agent SDK（构建带工具调用/循环/状态的 Agent）。
- 提供 MCP Server：`https://mcp.openrouter.ai/mcp`，OAuth 登录后即可接入 MCP 客户端（文档明确建议"读 MCP 技能仓库而非过时训练知识"）。
- 文档索引显示的核心路由与计费能力：
  - **Provider Routing**：请求路由到"最佳供应商"（https://openrouter.ai/docs/guides/routing/provider-selection.md）
  - **Model Fallbacks**：模型间自动故障转移/回退（https://openrouter.ai/docs/guides/routing/model-fallbacks.md）
  - **BYOK**：用户自带供应商 API Key（https://openrouter.ai/docs/guides/overview/auth/byok.md）
  - **Batch API**：异步批量推理（https://openrouter.ai/docs/batch-quickstart.md）
  - **OAuth PKCE**、**Management API Keys**（编程式管理密钥）、**Stripe Projects**（面向应用内嵌的计费集成）
  - 多模态：图像/视频生成、TTS/STT、PDF/图像输入
  - 可观测性：trace 广播到 Langfuse、LangSmith、Datadog、ClickHouse、BigQuery、Grafana、Arize 等

### 推断
- OpenRouter 的算力池构建方式以**聚合第三方供应商为主、自身不依赖大规模自建 GPU 集群**。依据：Provider Routing + BYOK + Model Fallbacks 机制的存在，说明其核心价值是路由与计费中转而非底层算力。（注意：OpenRouter 自身也提供部分端点，但本次未读到其自建算力的直接证据。）
- 计费模式推断为"按 token 转售 + 平台加价/抽成"，用户侧按 token 计费；BYOK 场景下用户自付供应商费用。具体抽成比例未见公开数据。

---

## 2. SiliconFlow（硅基流动）

**定位**：国产模型 API 平台，提供对话/生图/语音/视频全模态模型。

### 事实（来源：https://siliconflow.cn/pricing 模型价格中心）
- 定价页为"模型价格总览"，一屏对比输入/输出/缓存命中价格（元/百万 token），支持按厂商筛选（DeepSeek、Qwen、MiniMax、Z-AI、Kimi、Stepfun、混元、Wan 等）。
- **分时定价**（DeepSeek-V4-Flash，deepseek-ai/DeepSeek-V4-Flash）：
  - 2:00–8:00 时段：输入 ¥1.50 / 输出 ¥4.50 / 缓存命中 ¥0.15（每百万 token）
  - 0:00–2:00 与 8:00–24:00 时段：输入 ¥3.00 / 输出 ¥9.00 / 缓存命中 ¥0.30
- 其他模型参考价（元/百万 token，输入/输出/缓存）：
  - DeepSeek-V4-Pro：¥12.00 / ¥24.00 / ¥1.00
  - DeepSeek-V3.2：¥4.00 / ¥6.00 / ¥0.40
  - DeepSeek-V3.2 (Pro)：¥4.00 / ¥6.00 / ¥0.40
  - DeepSeek-V3.1-Terminus：¥4.00 / ¥12.00 / ¥0.40
- 语音/视频模型按次或按个计费：Wan2.2-I2V-A14B 与 Wan2.2-T2V-A14B 输出 ¥2.00/个；MOSS-TTSD-v0.5、CosyVoice2-0.5B ¥0.05；Qwen3-ASR-1.7B、SenseVoiceSmall、XingChenASR-V3.2 免费。

### 推断
- 硅基流动为**自建算力池**的国产平台：人民币计价 + 分时低价（2–8 点闲时折扣）暗示自营 GPU 集群与成本调度；"缓存命中"单独计价说明其推理栈采用 KV Cache 缓存（与 vLLM/SGLang 类引擎的 prefix caching 能力吻合）。此推断基于定价结构，未读到其算力规模/集群架构的官方披露。
- 模型接入方式推断为"自托管开源模型 + 部分第三方模型转售"（页面同时展示 DeepSeek/Qwen 等多家模型，具体托管方式未披露）。

---

## 3. Together AI

**定位**：美国推理云，自建 GPU 集群 + Serverless 推理。

### 事实（来源：https://www.together.ai/pricing）
- 产品线：**Serverless Inference**（按 token）、**Provisioned Throughput**（预留吞吐）、**Dedicated Inference**（专享推理）、**GPU Clusters**（GPU 集群）、Sandbox、Managed Storage、Model Shaping、Fine-Tuning。
- 参考价（每百万 token）：Qwen3.5-122B-A10B $6.00 / $15.00 / $10.00；Qwen3.5-397B-A17B $8.00 / $20.00 / $22.00（页面列名被截断，第三列疑为 Batch API 价或缓存价，未确认）。
- 微调计费：按训练数据集 token 总量计费（数据集大小 × epoch 数 + 验证集 token）。
- 页面宣传：DeepSeek V4 Pro 0813 与 GPT-5.6 Sol 的 DeepSWE 基准对比；B200 按需实例上线；MiniMax-M3 高效推理上线。

### 推断
- Together 为**自建 GPU 算力池**（GPU Clusters、Dedicated Inference、Provisioned Throughput 三类产品均需自有硬件支撑），并提供从 Serverless 到裸 GPU 集群的阶梯式部署形态。
- 模型接入方式：自托管主流开源模型（Qwen、DeepSeek 等）+ 微调服务，非第三方聚合。

---

## 4. DeepInfra

**定位**：推理云（"inference cloud"），按 token 与按图像计费。

### 事实（来源：https://deepinfra.com/pricing）
- 语言模型按 token 计费；图像模型按张计费，公式含分辨率与迭代次数：
  - FLUX-1.1-pro：$0.04/张
  - FLUX-2-dev：$0.01 × (w/1024) × (h/1024) × (iters/28)
  - FLUX-1-schnell：$0.0005 × (w/1024) × (h/1024) × iters
  - FLUX.1-Kontext-dev：$0.01 × (w/1024) × (h/1024) × (iters/25)
- 页面公告：DeepInfra 完成 $107M Series B 融资以扩展推理云。

### 推断
- DeepInfra 为**自建 GPU 推理云**（融资公告 + "Simple Pricing, Deep Infrastructure" 定位）。模型接入为自托管开源模型（FLUX、语言模型等）。

---

## 5. Fireworks AI

**定位**：美国推理平台，Serverless 按 token + 按 GPU 秒的裸部署。

### 事实（来源：https://fireworks.ai/pricing）
- 三种产品形态：
  - **Serverless Inference**：按 token 计费、零冷启动、$1 免费额度、后付费
  - **Training**：开源模型微调
  - **On Demand Deployments**：按 GPU 秒计费，更高速度/限流/低成本
- **按 GPU 小时价格**（8 月 31 日前 → 9 月 1 日起）：
  - H100 80GB：$7.00 → $8.00
  - H200 141GB：$7.00 → $8.00
  - B200 180GB：$10.00 → $13.00
  - B300 288GB：$12.00 → $15.00
  - GB300 288GB：$18.00 → $20.00
- 区域受限部署加收 **1.5 倍溢价**（暗示多区域部署能力）。

### 推断
- Fireworks 为**自建 GPU 集群**，且是本次调研中唯一给出明确"按 GPU 秒"裸金属定价的平台；Serverless 层按 token 计费，两层并存。
- 价格上调（8 月→9 月）反映 GPU 成本上行或供需变化，属页面事实，但原因未披露。

---

## 6. 火山方舟（Volcano Ark）

**状态：仅获得搜索结果摘要，未成功读取页面正文，以下为摘要级信息，需后续验证。**

### 事实（来源：搜索结果摘要，URL 见下）
- 按 token 后付费，计费公式按模型推理消耗的 token 数量计算。
- **TPM 保障包**：针对特定模型及版本、保障请求并发达到一定 TPM（Tokens Per Minute）的计费模式；相比普通按 token 计费，具备更高并发、更低延迟、更强稳定性。
- 在线推理与离线推理均按 token 单价计费（元/百万 token）。
- 提供 Agent Plan 企业版套餐，内含 AFP 抵扣规则（不同模型及专业数据集的抵扣公式与系数）。
- 相关 URL：
  - https://docs.volcengine.com/docs/ark/model-pricing?lang=zh （模型价格）
  - https://www.volcengine.com/docs/82379/1544106 （模型价格）
  - https://docs.volcengine.com/docs/82379/1544681 （模型服务计费说明）
  - https://www.volcengine.com/docs/82379/2516287 （套餐内 AFP 抵扣规则）

### 推断
- 火山方舟为**自建算力池**（字节跳动云基础设施），计费以按 token 后付费为主，TPM 保障包属于"预留并发"型计费（类似 Together 的 Provisioned Throughput）。此推断待页面正文验证。

---

## 7. 阿里云百炼（Alibaba Cloud Bailian）

**状态：未完成调研。** 本次执行中相关页面读取失败（重定向被取消），未获得任何可引用的页面证据。不提供任何未经核实的定价、模型数量或区域信息。

---

## 横向对比表（基于上述已核实事实）

| 平台 | 算力池构建方式 | 模型接入/路由 | 计费模式 | API 形态 | 证据状态 |
|---|---|---|---|---|---|
| OpenRouter | 聚合第三方为主（推断） | Provider Routing、Model Fallbacks、BYOK | 按 token（推断转售） | OpenAI 兼容 API + SDK + MCP Server + Batch API | ✅ 已读官方文档 |
| SiliconFlow | 自建（推断） | 自托管开源模型为主（推断） | 按 token（含分时价、缓存价）、按张/按个 | 模型 API 价格中心（对话/生图/语音/视频） | ✅ 已读定价页 |
| Together AI | 自建 GPU 集群 | 自托管开源模型 + 微调 | Serverless 按 token、Provisioned/Dedicated、微调按 token 量 | Serverless API + GPU Clusters | ✅ 已读定价页（部分列名截断） |
| DeepInfra | 自建推理云 | 自托管开源模型 | 语言按 token、图像按张（分辨率×迭代公式） | 按 token API + 图像 API | ✅ 已读定价页（截断） |
| Fireworks | 自建 GPU 集群 | 自托管开源模型 + 微调 | Serverless 按 token；裸部署按 GPU 秒 | Serverless API + On Demand Deployments | ✅ 已读定价页 |
| 火山方舟 | 自建（推断） | 自托管（推断） | 按 token 后付费、TPM 保障包、套餐 AFP | 模型 API（在线/离线推理） | ⚠️ 仅搜索摘要 |
| 阿里云百炼 | — | — | — | — | ❌ 未完成 |

**区域覆盖**：仅 Fireworks 明确显示多区域（区域受限部署 1.5x 溢价）；SiliconFlow 为人民币计价（中国区）；其余平台未在本次读取的页面中披露区域清单。

**延迟与吞吐**：本次读取的公开页面均未披露可引用的 P50/P99 延迟或吞吐数据。唯一相关表述为火山方舟 TPM 保障包"更高并发、更低延迟"（摘要级，未验证）。**此为本调研的关键证据缺口**，需后续查阅各平台文档/博客或基准测试（如 Artificial Analysis、DeepSWE 类榜单）补充。

---

## 参考资料列表

1. OpenRouter 首页 — https://openrouter.ai/
2. OpenRouter 文档索引 — https://openrouter.ai/docs/llms.txt
3. OpenRouter Provider Routing — https://openrouter.ai/docs/guides/routing/provider-selection.md
4. OpenRouter Model Fallbacks — https://openrouter.ai/docs/guides/routing/model-fallbacks.md
5. OpenRouter BYOK — https://openrouter.ai/docs/guides/overview/auth/byok.md
6. OpenRouter Batch API — https://openrouter.ai/docs/batch-quickstart.md
7. SiliconFlow 模型价格中心 — https://siliconflow.cn/pricing
8. Together AI 定价 — https://www.together.ai/pricing
9. DeepInfra 定价 — https://deepinfra.com/pricing
10. Fireworks 定价 — https://fireworks.ai/pricing
11. 火山方舟模型价格 — https://docs.volcengine.com/docs/ark/model-pricing?lang=zh （未读正文）
12. 火山方舟模型价格 — https://www.volcengine.com/docs/82379/1544106 （未读正文）
13. 火山方舟模型服务计费说明 — https://docs.volcengine.com/docs/82379/1544681 （未读正文）
14. 火山方舟 AFP 抵扣规则 — https://www.volcengine.com/docs/82379/2516287 （未读正文）

---

## 结论要点（供总报告整合）

1. **两类算力池模式并存**：聚合中转型（OpenRouter，靠路由/回退/BYOK 做多供应商调度）与自建算力型（SiliconFlow、Together、DeepInfra、Fireworks、火山方舟，靠自营 GPU 集群 + Serverless 层）。
2. **计费模式分层**：面向开发者的 Serverless 层普遍按 token（含缓存命中价、分时价），面向重负载客户提供预留型计费（Together Provisioned Throughput、火山方舟 TPM 保障包），裸算力层按 GPU 秒/小时（Fireworks 给出了明确的 H100/B200/B300 小时价）。
3. **API 形态趋同**：OpenAI 兼容 + 多模态扩展 + MCP/Agent SDK 成为标配；OpenRouter 额外提供 Batch API 与可观测性 trace 广播。
4. **证据缺口**：延迟/吞吐（P50/P99）公开数据缺失；火山方舟与阿里云百炼需补读官方文档页。