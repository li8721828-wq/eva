# 算力池化机制调研笔记

> 子任务：调研"算力池化"机制 —— 如何聚合多家供应商算力形成"池"、动态调度与优先级策略、多供应商冗余与故障切换、计费与结算模型。
> 调研时间：2026-09。本文件区分【已验证事实】（来自本次调研中实际读取的文档/页面）与【推断/观点】（基于已验证事实的推理或一般性认知，未经本次来源证实）。

---

## 1. 核心概念：算力池化

【推断/观点】算力池化（compute pooling）指将多家异构 LLM 供应商（OpenAI、Anthropic、Google、Azure、各类国产模型厂商等）的推理能力抽象为统一 API 入口背后的"资源池"，由网关层统一做模型映射、路由选择、故障转移与计量计费。用户只面对一个 API（如 OpenAI 兼容接口），网关决定请求实际由哪家供应商执行。池化的价值在于：单一供应商不可用时自动切换、按成本/延迟/可用性动态选择最优供应商、统一计量与结算。

【已验证事实】OpenRouter 官方文档将其定位描述为"通过单一 API 端点访问数百个 AI 模型，自动处理 fallback，并为每个请求选择最具成本效益的选项"（来源：https://openrouter.ai/docs/quickstart）。这直接印证了"统一入口 + 自动路由 + 成本优先"的池化模型。

---

## 2. 已验证事实：各平台实现细节

### 2.1 OpenRouter（商业聚合平台）

来源：https://openrouter.ai/docs/quickstart 、https://openrouter.ai/docs/guides/routing/provider-selection.md 、https://openrouter.ai/docs/guides/routing/model-fallbacks.md

- 统一端点：`POST https://openrouter.ai/api/v1/chat/completions`，OpenAI 兼容格式，任意语言/框架可直接调用。
- 模型目录：数百个模型通过 `openrouter.ai/models` 浏览，或 `GET /api/v1/models` 程序化获取全部 slug。
- 最新别名机制：如 `~openai/gpt-latest` 始终解析到 OpenAI 最新旗舰模型，用户无需改代码即可跟随模型版本升级；`~anthropic/claude-sonnet-latest` 等同类别名在模型 fallback 示例中出现。
- 自动 fallback：请求可携带 `models: [...]` 数组（如 `['~anthropic/claude-sonnet-latest', 'gryphe/mythomax-l2-13b']`），主模型失败时自动切换到备选模型（来源：model-fallbacks.md）。
- Provider 选择基于统计：官方文档说明使用滚动 5 分钟窗口的百分位统计（p50 中位数、p75、p90、p99）来衡量供应商表现，用于 provider 路由决策（来源：provider-selection.md）。这为"延迟优先/可用性优先"调度提供了量化依据。
- 可选请求头：`HTTP-Referer`（站点 URL，用于排行榜归因）、`X-OpenRouter-Title`（站点名），用于应用出现在 OpenRouter 排行榜上 —— 说明平台有公开的性能/用量排行榜体系。
- MCP 接入：提供远程托管的 MCP server（https://mcp.openrouter.ai/mcp），AI 编码工具可实时拉取模型列表、价格、余额、用量排行等数据。

### 2.2 LiteLLM Router（开源网关/代理）

来源：https://docs.litellm.ai/docs/routing 、https://docs.litellm.ai/docs/proxy/reliability

- 核心能力（routing 文档）：跨多个 deployment（如 Azure/OpenAI）做负载均衡；通过排队机制优先保证重要请求不失败；基础可靠性逻辑包括 cooldown（冷却）、fallbacks、timeouts、retries（固定 + 指数退避）；生产环境用 Redis 跟踪 cooldown 状态与用量（tpm/rpm 限额管理）。
- 配置模型：`model_list` 中每个条目定义 `model_name`（对外统一名）+ `litellm_params`（实际供应商映射，如 `model: azure/<deployment>`、`api_base`、`api_key`、`rpm` 限流）。即"一个对外模型名 → 多个/单个真实部署"的映射层。
- Fallback 机制（reliability 文档）：
  - 声明式配置：`fallbacks=[{"gpt-3.5-turbo": ["gpt-4"]}]`，即某模型失败（超过 num_retries 后）自动转移到另一模型组。
  - 按顺序执行：`["gpt-3.5-turbo", "gpt-4", "gpt-4-32k"]` 会依次尝试。
  - 三类 fallback：普通 fallback、`content_policy_fallbacks`（内容策略拦截时切换）、context-window fallbacks（上下文超限时切换）。
  - 上下文窗口预检：`router_settings.enable_pre_call_checks: true` 时，调用前先检查输入 token 是否超出模型上下文窗口，超出则触发 fallback；每个 deployment 可用 `model_info.max_input_tokens` 覆盖默认限制。
  - 注意：自 Proxy v1.85.0 起，`mock_testing_fallbacks` 等测试标志对 Proxy 请求不再生效，仅用于直接 Router 调用测试 —— 说明生产 fallback 验证需真实触发供应商错误。
- 量化限流：每个 deployment 可配 `tpm`（tokens per minute）与 `rpm`（requests per minute），Router 据此做用量感知调度。

### 2.3 one-api（开源中转/分发网关）

来源：https://github.com/songquanpeng/one-api

- 定位：LLM API 管理与分发系统（"key 管理与二次分发"），将 OpenAI、Azure、Anthropic Claude、Google Gemini、DeepSeek、字节豆包、ChatGLM、文心一言、讯飞星火、通义千问、360 智脑、腾讯混元等主流模型统一为单一 API 适配。
- 工程形态：单可执行文件（Go 编写，基于 gin-template），提供 Docker 镜像，一键部署，支持英文 UI。
- 社区规模（GitHub 页面数据）：36.7k stars、6.8k forks、MIT 许可证。
- 【推断/观点】one-api 是"民间中转站"的典型开源底座：运营者接入上游供应商 key，向下游用户以统一 API 转售，天然支持"充值 + 按量计费 + 差价"的商业模式（本次未读到其计费源码/文档，属推断）。

---

## 3. 动态调度与优先级策略（成本/延迟/可用性）

【已验证事实】
- 成本优先：OpenRouter 明确宣称"为每个请求选择最具成本效益的选项"（quickstart）。
- 可用性优先：OpenRouter 的模型级 fallback（`models` 数组）与 LiteLLM 的 provider fallback（失败超过重试次数后切换）都是"可用性优先"的兜底机制；LiteLLM 的 cooldown 机制让故障供应商暂时退出候选池。
- 延迟优先：OpenRouter 用滚动 5 分钟窗口的 p50/p75/p90/p99 百分位统计评估供应商表现，作为 provider 路由依据 —— 即延迟分布（而非单次均值）参与决策。
- 用量感知：LiteLLM 以 tpm/rpm 限额 + Redis 跟踪用量，避免打爆单一供应商配额。

【推断/观点】
- 三种优先级通常组合使用而非互斥：典型策略是"成本优先 + 延迟约束"（在 p95 延迟低于阈值的供应商中选最便宜的），故障时降级为"可用性优先"（任意健康供应商）。OpenRouter 的百分位统计正是为这种约束式选择提供数据基础。
- 池化的调度粒度分两层：模型级（同义模型/别名在不同厂商间切换，如 `~anthropic/claude-sonnet-latest` 与开源模型互备）和供应商级（同一模型的多家部署，如 LiteLLM 的多个 Azure deployment）。
- 优先级策略的工程难点在于指标时效性：5 分钟窗口的百分位统计对突发故障反应偏慢，因此需要 cooldown（快速剔除）与 fallback（即时转移）配合。

---

## 4. 多供应商冗余与故障切换

【已验证事实】
- LiteLLM：fallback 按声明顺序执行；三类 fallback（普通/内容策略/上下文窗口）覆盖不同失败原因；`default_fallbacks` 用于模型组配置错误时的兜底；Redis 支撑跨实例的 cooldown 状态共享（生产多实例场景）。
- OpenRouter：模型 fallback 数组 + provider 层自动切换；平台侧（而非用户侧）负责大部分故障转移，用户只需声明可接受的备选模型。
- one-api：支持多供应商接入，天然具备"同一模型多渠道"配置能力（本次未读到其具体切换算法源码，仅从架构定位推断）。

【推断/观点】
- 冗余设计的关键参数：重试次数（num_retries）、冷却时长（cooldown）、fallback 顺序、健康检查频率。这些参数在 LiteLLM 中全部可配置，说明"池化"的可靠性本质上是可调参的故障转移策略，而非简单的请求转发。
- 故障切换的隐藏成本：切换供应商后上下文/工具调用状态可能不兼容（不同模型对 system prompt 的遵循度不同），因此生产环境通常只在"同义模型组"内做自动切换，跨能力差异大的模型切换需人工策略。

---

## 5. 计费与结算模型

【已验证事实】
- OpenRouter 提供余额/用量数据接口（MCP server 可拉取 credit balance、usage rankings），说明其采用"预充值余额 + 按请求计量"模式；模型目录页公开各模型价格（本次未读取到具体价格表页面，价格数值未验证）。
- LiteLLM 的 tpm/rpm 配置本质是"配额计量"而非计费；LiteLLM 本身是开源网关，计费通常由上层（代理运营者）实现。
- one-api 定位为"key 管理与二次分发"，其商业模式基础是转售（本次未读到其计费模块源码）。

【推断/观点】（以下均未经本次来源证实，属一般性认知，需后续验证）
- 中转/聚合平台的典型计费模型有四类：
  1. 按 token 计量（最主流，与上游一致，按输入/输出 token 分别计价）；
  2. 按量/按次（如按请求数、按分钟数）；
  3. 包月/会员订阅（固定月费换额度或折扣）；
  4. 差价套利（平台以批发价/折扣价从上游采购，以零售价或加价出售；或利用不同供应商同模型价差路由到低价供应商赚取差价 —— 与"成本优先"路由直接相关）。
- 差价套利模式与成本优先路由天然耦合：平台路由到更便宜的供应商即可扩大毛利，这也是 OpenRouter"最具成本效益"表述背后的商业动机。
- 结算风险：上游价格变动（如推理成本下降）会直接压缩差价空间，平台需动态调价或转向订阅/增值服务（见总体报告"未来趋势"维度）。

---

## 6. 未验证项与后续调研清单

以下内容本次未能读取到可靠来源（页面访问失败或未检索到），需后续补充：

- 硅基流动（SiliconFlow）的池化/调度实现细节（其介绍页访问被重定向取消，未成功读取）。
- 火山方舟、阿里云百炼、腾讯云 TI 等云厂商托管路由的具体策略（未检索到可读页面）。
- AWS Bedrock / Azure OpenAI 的模型路由与故障转移官方文档细节。
- OpenRouter 具体价格表、供应商分成比例、credits 充值规则（价格数值未验证）。
- one-api / New API 的计费、限流、渠道优先级算法源码级细节。
- 中国市场合规（未授权转售、备案、数据安全）相关法规条文原文。

---

## 7. 来源 URL 列表

已验证（本次实际读取成功）：
- https://openrouter.ai/docs/quickstart （统一端点、自动 fallback、成本最优、最新别名、MCP）
- https://openrouter.ai/docs/guides/routing/provider-selection.md （provider 路由、5 分钟窗口百分位统计 p50/p75/p90/p99）
- https://openrouter.ai/docs/guides/routing/model-fallbacks.md （models 数组自动 failover）
- https://docs.litellm.ai/docs/routing （负载均衡、cooldown/fallback/timeout/retry、Redis、tpm/rpm）
- https://docs.litellm.ai/docs/proxy/reliability （fallback 三类、顺序执行、enable_pre_call_checks、max_input_tokens、v1.85.0 mock 标志变更）
- https://github.com/songquanpeng/one-api （定位、支持模型列表、单二进制/Docker、36.7k stars、MIT）

尝试但未成功（不构成证据）：
- https://docs.siliconflow.cn/cn/userguide/introduction （重定向被取消）
- OpenRouter 文档索引中部分页面 404 / 重定向取消（具体 URL 见执行记录）

---

## 8. 结论（本子任务）

1. 【已验证】"算力池化"在主流实现中 = 统一 OpenAI 兼容入口 + 模型/供应商映射层 + 基于统计指标的路由决策 + 声明式故障转移 + 配额计量。OpenRouter 与 LiteLLM 分别代表商业聚合与开源网关两种形态，机制高度同构。
2. 【已验证】调度优先级有明确的工程化支撑：成本优先（OpenRouter 明示）、延迟优先（p50–p99 百分位统计）、可用性优先（fallback/cooldown/重试），三者组合使用。
3. 【已验证】冗余与故障切换是"可配置策略"而非黑盒：fallback 顺序、重试次数、冷却、上下文预检、tpm/rpm 限额均可声明式配置（LiteLLM 为最完整证据）。
4. 【推断】计费模型四类（按 token / 按量 / 包月 / 差价套利）中，差价套利与成本优先路由在机制上直接耦合，是商业聚合平台的核心盈利逻辑；具体价格与分成数据待验证。