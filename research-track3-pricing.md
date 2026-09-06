# 聚合平台定价现状调研（Track 3：SiliconFlow / OpenRouter / DeepInfra）

> 调研目标：核实三大聚合平台的定价模式（透传 / 加价 / 按量计费）、聚合厂商广度、计费与退款政策。
> 方法：优先直接读取已知官方 URL（read_web_page）。只有实际读取成功的页面才列为「已验证」并附 URL；读取失败或无证据的一律标注「未能核实」，不编造数据。

---

## 一、已验证事实清单（附来源 URL）

### 1. OpenRouter

来源：https://openrouter.ai/docs/faq.md（FAQ，读取成功）

- **定价模式：透传底层厂商定价，推理价格无加价**。原文："OpenRouter passes through the pricing of the underlying providers, while pooling their uptime, so you get the same pricing you'd get from the provider directly, with a unified API and fallbacks so that you get much better uptime."（透传上游定价并聚合其可用性，用户获得与直连厂商相同的价格，同时获得统一 API 与故障回退。）
- **计费模式：预充值 Credits + 按请求扣费**。Credits 为预存款，每次 API/聊天请求按模型与 provider 的每百万 token 价格从 Credits 扣除；prompt 与 completion 通常不同价，部分模型按请求、按图像、按 reasoning token 计费。
- **充值手续费（非推理加价）**：Stripe 支付收取 5.5%（最低 $0.80），Coinbase 加密支付收取 5%。
- **BYOK（自带 Key）模式**：收取 5% 费用；PAYG（按量付费）月清单价阈值 $25,000，企业版月清单价阈值 $200,000。
- **退款政策**：未使用的 Credits 可在交易处理后 24 小时内申请退款（Credits 页面退款按钮），超过 24 小时未申请则不可退。
- **免费模型限流**：无 Credits 时 50 请求/天，有 Credits 时 1000 请求/天，阈值 10 credits。
- **聚合广度**：统一 API 聚合"all the major LLM models on the market"，支持聚合账单与用量分析（Activity 页）。

来源：https://openrouter.ai/docs/guides/overview/models.md（Models 指南，读取成功）

- 提供 **400+ 模型**的统一 API；Models API 支持按 `output_modalities` 等查询参数过滤；provider 对象含 `context_length` 等属性（按 provider 区分上下文长度）。

来源：https://openrouter.ai/docs/llms.txt（文档索引，读取成功）

- 文档体系覆盖：Quickstart、Batch API、BYOK、Stripe Projects、OAuth PKCE、Workload Identity Federation、Management API Keys、路由元数据（routing metadata）、输入输出日志、可观测性广播（Arize AX、Braintrust、ClickHouse、Comet Opik、Datadog、BigQuery）等——侧面印证其具备路由/可观测性/密钥管理等平台能力。

### 2. SiliconFlow（硅基流动）

来源：https://siliconflow.cn/pricing（定价页，读取成功）

- **定价页形态**：提供"实时价格同步"，按厂商/模型分类展示，覆盖**对话、生图、语音、视频**四类模型。
- **聚合厂商广度**（页面可见厂商）：deepseek-ai、Z-ai、Kimi、MiniMax、Tongyi-MAI、Baidu、Qwen、Stepfun、inclusionAI、ChinaTelecom（混元 hunyuan）、ByteDance（Wan）、openmoss、FunAudioLLM、BAAI、Kolors 等。
- **计费粒度：每百万 token 计价，区分输入 / 输出 / 缓存命中价格**（对话模型），视频模型按"个"计价，部分语音模型免费或低价。
- **分时段定价**（已验证示例）：DeepSeek-V4-Flash 在 2:00–8:00 时段为 ¥1.50（输入）/¥4.50（输出）/¥0.15（缓存），其余时段为 ¥3.00/¥9.00/¥0.30。
- **其他可见价格示例**：DeepSeek-V4-Pro ¥12.00/¥24.00/¥1.00；DeepSeek-V3.2 ¥4.00/¥6.00/¥0.40；DeepSeek-V3.1-Terminus ¥4.00/¥12.00/¥0.40；视频模型 Wan2.2-I2V-A14B / Wan2.2-T2V-A14B ¥2.00/个；Qwen3-ASR-1.7B、SenseVoiceSmall 免费；MOSS-TTSD-v0.5、CosyVoice2-0.5B ¥0.05。
- **结论（已验证部分）**：按量计费（token / 张 / 个）模式明确；价格展示为人民币。

### 3. DeepInfra

来源：https://deepinfra.com/pricing（定价页，读取成功）

- **定价模式：按量计费**。语言模型按 token 计价（页面明确"Some of our language models offer per token pricing"）；图像模型按张计价。
- **图像模型价格示例**：FLUX-2-max $0.07/张；FLUX-2-pro $0.015/张；FLUX-1-Redux-dev $0.012 × (w/1024) × (h/1024) × (iters/25)；FLUX-1-dev $0.009 × (w/1024) × (h/1024) × (iters/25)；FLUX-1-schnell $0.0005 × (w/1024) × (h/1024) × iters；FLUX-1.1-pro $0.04/张。
- **模态覆盖**：ASR、Embeddings、Reranker、Text Generation、Text-to-Image、Text-to-Music、Text-to-Speech、Text-to-Video、World Model 等。
- **公司动态**：页面提及 DeepInfra 完成 $107M Series B 融资以扩展推理云（inference cloud）。
- **结论（已验证部分）**：按量计费模式明确；以美元计价。

---

## 二、定价模式横向小结（基于已验证事实）

| 平台 | 定价模式 | 计费粒度 | 聚合广度 | 加价/手续费 | 退款政策 |
|---|---|---|---|---|---|
| OpenRouter | 透传上游定价（无推理加价） | 每百万 token（prompt/completion 分价；部分按请求/图像/reasoning） | 400+ 模型、多家 provider | 充值手续费 Stripe 5.5%（最低 $0.80）/ Coinbase 5%；BYOK 5% | 未用 Credits 24 小时内可退，超期不可退 |
| SiliconFlow | 按量计费（是否透传上游未核实） | 每百万 token（输入/输出/缓存分价）、视频按个、分时段价格 | 十余家厂商（DeepSeek、Qwen、Kimi、MiniMax、混元、Wan 等） | 未核实 | 未核实 |
| DeepInfra | 按量计费（自营推理云，是否聚合第三方未核实） | 语言模型按 token、图像按张（含分辨率/迭代数公式） | 未核实（页面未列厂商清单） | 未核实 | 未核实 |

推断（明确标注为推断，非已验证）：OpenRouter 的"透传 + 充值手续费"是纯聚合转售形态；SiliconFlow 与 DeepInfra 的定价页均展示按量价格，但未说明其价格相对上游厂商是透传还是加价，无法据此判定其商业模式是否含差价。

---

## 三、未能核实清单

1. **SiliconFlow 是否透传上游价格 / 加价率**：定价页未说明价格构成（未能核实）。
2. **SiliconFlow 充值、余额、退款政策**：未读到相关官方页面（未能核实）。
3. **SiliconFlow 完整价格表**：页面内容较长被截断，仅部分模型价格可见（未能核实全量）。
4. **DeepInfra 聚合厂商广度**：定价页未展示厂商清单；其商业模式为自营推理云还是聚合第三方未能核实。
5. **DeepInfra 退款政策、SLA、计费单位换算（如是否含税）**：未读到（未能核实）。
6. **OpenRouter 实时模型价格表**：Models 指南确认 400+ 模型与 provider 属性，但本次未读取完整价格数据（未能核实具体价格数值）。
7. **三平台对"中转算力池"下层的关联**（如是否将自建推理服务注册为渠道）：超出定价页范围，未核实。

---

## 四、失败的 agent / 工具调用记录

- 会话中出现执行完整性提示：**部分 read_web_page 调用未成功完成**（共 3 条提示），无法确认具体失败 URL；本次已确认读取成功的页面见第一节列表，其余涉及 SiliconFlow 退款政策、DeepInfra 聚合广度等目标页面未读到，均已在第三节标注「未能核实」。
- 本次任务未依赖 web_search 作为证据来源（任务约束优先直接读取已知官方 URL；搜索结果仅作导航，不视为页面证据）。

---

## 五、后续补充建议

1. 重试读取 SiliconFlow 文档站（如 docs.siliconflow.cn）中计费/充值/退款相关页面，核实其价格构成与退款政策。
2. 读取 OpenRouter 定价相关页面（如 /docs/pricing 或 models 页完整数据）获取实时价格表与 provider 级价格差异。
3. 读取 DeepInfra 文档（deepinfra.com/docs）核实其厂商聚合模式、退款政策与 SLA。
4. 若 read_web_page 持续失败，需先解决网络/页面访问权限问题后再补采数据，避免以推断代替证据。