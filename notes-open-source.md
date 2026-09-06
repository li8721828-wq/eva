# 开源实现调研笔记：LLM API 中转与网关项目

调研日期：2026-09-03
调研方式：web 搜索 + 阅读 GitHub 仓库主页 / 官网首页。所有数据均来自本次会话中实际读取到的页面，未读取到的项目明确标注"未能核实"。

---

## 一、已核实项目（数据来自本次会话实际读取的页面）

### 1. one-api（songquanpeng/one-api）

- **来源**：https://github.com/songquanpeng/one-api （主页已读取）
- **活跃度**：Star 36.7k，Fork 6.9k，提交数 1,210（截至读取时页面显示；具体最近提交日期未在页面中捕获）
- **技术栈**：Go 语言；单可执行文件；提供 Docker 镜像（justsong/one-api、ghcr.io/songquanpeng/one-api）；SQLite/MySQL/PostgreSQL；多机部署时可用 Redis 缓存（REDIS_CONN_STRING、SYNC_FREQUENCY 环境变量）；主从节点模式（NODE_TYPE=slave）
- **核心功能**（README 核实）：
  - 多模型聚合：OpenAI ChatGPT（含 Azure OpenAI）、Anthropic Claude（含 AWS Claude）、Google PaLM2/Gemini、Mistral、字节豆包（火山引擎）、百度文心一言、阿里通义千问、讯飞星火、智谱 ChatGLM、360 智脑、腾讯混元、Moonshot AI、百川、MINIMAX、Groq、Ollama、零一万物、阶跃星辰、Coze、Cohere、DeepSeek、Cloudflare Workers AI、DeepL、together.ai、novita.ai、硅基流动 SiliconCloud、xAI 等
  - 统一 OpenAI 格式 API 适配，支持配置镜像与第三方代理
  - 负载均衡：多渠道负载均衡访问
  - 流式输出（stream 模式）
  - 令牌管理：过期时间、额度、允许 IP 范围、允许模型
  - 兑换码管理：批量生成/导出、充值
  - 渠道管理：批量创建；用户分组 + 渠道分组，支持不同倍率
  - 计量：额度明细查看、以美元显示额度、新用户初始额度
  - 失败自动重试；模型映射/重定向；绘图接口；Cloudflare AI Gateway 支持
  - 公告、充值链接、邀请奖励
- **合规提示**（README 原文）：须遵守 OpenAI 使用条款与法律法规；根据《生成式人工智能服务管理暂行办法》，不得对中国地区公众提供未经备案的生成式 AI 服务
- **适用场景**：个人/团队 key 管理与二次分发、自建中转站、企业内部多模型统一入口

### 2. new-api（QuantumNous/new-api）

- **来源**：https://github.com/QuantumNous/new-api （主页已读取）
- **活跃度**：Star 47.2k，Fork 11.2k，提交数 6,281（截至读取时；具体最近提交日期未捕获）
- **技术栈**：Go（one-api 的衍生/下一代版本）；Docker 部署；提供 Electron 桌面端目录；多语言（简中、繁中、英、法、日）
- **核心功能**（README 核实）：
  - 多模型聚合与协议互转：可将各类 LLM 互转为 OpenAI-compatible / Claude-compatible / Gemini-compatible 格式
  - API 格式支持：OpenAI Responses API、OpenAI Realtime API（含 Azure）、Claude Messages、Google Gemini、Rerank 模型（Cohere、Jina）
  - 智能路由：渠道加权随机、失败自动重试、用户级模型限流
  - 格式转换：OpenAI ⇄ Claude Messages、OpenAI → Gemini、Gemini → OpenAI（仅文本，暂不支持 function calling）、OpenAI ⇄ Responses（开发中）；thinking-to-content 功能
  - Reasoning effort 支持（o3-mini-high 等）
  - 认证与安全：Discord / LinuxDO / Telegram / OIDC 统一认证登录；key 配额查询工具（new-api-key-tool）
  - 计量与账户体系（继承 one-api 体系：额度、倍率、兑换码等）
- **适用场景**：个人/企业级模型统一管理网关、组织级认证、用量分析与成本核算、私有化部署

### 3. LiteLLM Gateway（BerriAI/litellm）

- **来源**：https://github.com/BerriAI/litellm （主页已读取）
- **活跃度**：Star 57.9k，Fork 11.1k，提交数 46,516（截至读取时，提交非常活跃；具体最近提交日期未捕获）
- **技术栈**：Rust core（litellm-rust）+ Python SDK；AI Gateway 代理服务（gateway 目录）；Docker / Helm / Terraform 部署；Prometheus 指标；enterprise 目录（企业版功能）
- **核心功能**（README 核实）：
  - 100+ LLM API 统一接入，OpenAI 或原生格式调用（Bedrock、Azure、OpenAI、Anthropic、VertexAI、vLLM、Nvidia NIM 等）
  - 成本追踪：内置 model_prices_and_context_window.json 模型价格库
  - 负载均衡、guardrails（护栏）、日志记录
  - MCP Gateway：接入 MCP Server 并通过 /chat/completions 调用 MCP 工具
  - A2A 智能体协议支持（Python SDK + AI Gateway），可调用 LangGraph、Vertex AI Agent Engine、Azure AI Foundry、Bedrock AgentCore、Pydantic AI 等
  - 路由插件（router_plugins.json）、provider 端点支持表
- **适用场景**：企业级 AI Gateway（成本控制、多供应商路由、治理），Python 生态深度集成，Kubernetes 环境（Helm）

### 4. Portkey AI Gateway（Portkey-AI/gateway）

- **来源**：https://github.com/Portkey-AI/gateway （主页已读取）
- **活跃度**：Star 12.9k，Fork 1.3k，提交数 3,457（截至读取时；具体最近提交日期未捕获）
- **技术栈**：TypeScript；轻量（122kb，<1ms 延迟）；Cloudflare Workers 可部署（wrangler.toml）；Docker / docker-compose / deployment.yaml
- **核心功能**（README 核实）：
  - 路由 250+ LLM（README 另一处称 1600+ 语言/视觉/音频/图像模型），统一 API
  - 故障转移：失败请求自动 fallback 到其他 provider/模型，可指定触发错误类型
  - 自动重试：最多 5 次，指数退避
  - 负载均衡：多 API key / provider 间分发
  - 条件路由、guardrails（50+ 护栏）
  - 观测：每次调用日志（调用者、参数、响应、延迟）
  - Portkey Models：开源 LLM 定价库，2,300+ 模型、40+ 供应商
  - MCP Gateway：统一认证、访问控制、身份转发
  - 规模背书：每日处理 10B+ tokens（README 自述）
- **适用场景**：快速接入多模型、可靠性优先的应用（自动重试/fallback）、边缘部署（Cloudflare Workers）、企业观测需求

### 5. Apache APISIX（AI 网关方向）

- **来源**：https://github.com/apache/apisix （主页已读取，见本会话早期记录）
- **活跃度**：Star 17.1k，Fork 2.9k，提交数 5,174（截至读取时；具体最近提交日期未捕获）
- **技术栈**：云原生 API 网关（Lua/OpenResty 生态，Nginx 内核）；REST Admin API；插件体系
- **核心功能**（主页核实）：
  - 定位为 Cloud-Native API Gateway and AI Gateway
  - 高性能：单核 QPS 18k、平均延迟 <0.2ms（官方 README 数据）
  - 插件机制：限流、IP 过滤、故障注入等；AI 相关能力通过插件扩展
  - Admin API 默认仅允许 127.0.0.1 访问，可配置 allow_admin
- **适用场景**：已有 APISIX 基础设施的企业在其上叠加 AI 路由/限流能力；大规模流量网关场景
- **备注**：本次仅核实了仓库主页；其 AI 插件的具体功能清单（如 AI Proxy 插件细节）未在本次会话中单独读取，需进一步核实

### 6. OpenRouter（闭源，商业模式参考）

- **来源**：https://openrouter.ai/ （官网首页已读取，见本会话早期记录）
- **性质**：闭源商业平台，作为商业模式参考
- **核心数据**（官网首页核实）：500+ 模型、80+ 供应商、月处理 tokens 300T+、全球用户 10M+；文本/图像/视频/音频统一接口
- **商业模式要点**（官网首页核实）：
  - 统一接口接入所有主流模型；按量计费
  - 分布式基础设施：供应商故障时自动 fallback 到其他 provider
  - 边缘路由降低延迟
  - 自定义数据策略：可限制 prompt 只发往指定模型/供应商（企业治理卖点）
  - 提供 MCP server 支持编辑器内调用
- **适用场景**：多模型聚合的商业模式标杆（统一入口 + 倍率/按量定价 + 故障转移 + 数据治理）

---

## 二、未能核实项目（本次会话未能读取到有效页面）

### 7. Higress AI 网关（alibaba/higress）

- 本次尝试读取 https://github.com/alibaba/higress 失败（重定向被取消），未能核实其 star 数、提交活跃度与功能细节。
- 一般背景（未在本会话核实，仅供参考）：Higress 是阿里开源的云原生网关（基于 Envoy/Istio），近年推出 AI 网关能力（AI Proxy 插件、多模型路由、fallback 等）。**以上描述未经本次会话来源核实，请勿直接引用为调研结论。**
- 后续核实步骤：重新访问 GitHub 仓库主页或 Higress 官网（higress.io）确认 star 数、最近提交时间与 AI 功能列表。

### 8. Kong AI Gateway

- 本次搜索 "Kong AI Gateway plugin open source GitHub" 无结果，且未读取到任何 Kong AI Gateway 页面，全部数据未能核实。
- 一般背景（未在本会话核实，仅供参考）：Kong 是知名开源 API 网关（Lua/OpenResty），近年发布 AI Gateway 插件（AI Proxy、AI Prompt Guard 等）。**以上描述未经本次会话来源核实，请勿直接引用为调研结论。**
- 后续核实步骤：访问 Kong 官网（konghq.com）AI Gateway 页面或 GitHub（Kong/kong、Kong/ai-gateway-plugins）确认功能与活跃度。

---

## 三、对比表（仅含已核实项目）

| 项目 | 技术栈 | Star | Fork | 提交数 | 多模型聚合 | 负载均衡 | 故障转移 | 计费计量 | 密钥/令牌管理 | 配额限流 | 审计/日志 | 适用场景 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| one-api | Go，单二进制，Docker | 36.7k | 6.9k | 1,210 | ✅ 30+ 家 | ✅ 多渠道 | ✅ 失败自动重试 | ✅ 额度明细/倍率/兑换码 | ✅ 令牌+分组 | ✅ 令牌额度/分组倍率 | ⚠️ 额度明细（完整审计日志未明确） | 自建中转站、key 二次分发 |
| new-api | Go，Docker | 47.2k | 11.2k | 6,281 | ✅ 含协议互转 | ✅ 加权随机 | ✅ 自动重试 | ✅ 继承 one-api 体系 | ✅ 令牌+OIDC 等 | ✅ 用户级模型限流 | ⚠️ 用量分析（README 提及） | 个人/企业统一网关、组织认证 |
| LiteLLM | Rust core + Python SDK | 57.9k | 11.1k | 46,516 | ✅ 100+ API | ✅ | ✅ | ✅ 成本追踪+价格库 | ✅ | ✅ | ✅ 日志+Prometheus | 企业 AI Gateway、Python 生态 |
| Portkey Gateway | TypeScript，122kb | 12.9k | 1.3k | 3,457 | ✅ 250+/1600+ | ✅ | ✅ fallback+5 次重试 | ✅ Portkey Models 定价库 | ✅ | ✅ | ✅ 全量调用日志 | 可靠性优先应用、边缘部署 |
| Apache APISIX | Lua/OpenResty | 17.1k | 2.9k | 5,174 | ⚠️ 插件扩展 | ✅ 网关级 | ⚠️ 插件 | ❌ 非内置 | ⚠️ 插件 | ✅ 限流插件 | ✅ 网关日志 | 已有网关基础设施叠加 AI 能力 |
| OpenRouter（闭源） | 商业平台 | — | — | — | ✅ 500+ 模型/80+ 供应商 | ✅ 边缘路由 | ✅ 供应商 fallback | ✅ 按量计费 | ✅ 数据策略 | ✅ | ⚠️ 未核实 | 商业模式参考标杆 |

注：✅=主页明确核实；⚠️=主页提及但细节未核实；❌=主页未体现。Higress 与 Kong 因页面未读取成功，未列入对比表。

---

## 四、来源链接

已核实来源：
- one-api：https://github.com/songquanpeng/one-api
- new-api：https://github.com/QuantumNous/new-api
- LiteLLM：https://github.com/BerriAI/litellm
- Portkey Gateway：https://github.com/Portkey-AI/gateway
- Apache APISIX：https://github.com/apache/apisix
- OpenRouter：https://openrouter.ai/

未能核实来源（待重试）：
- Higress：https://github.com/alibaba/higress
- Kong AI Gateway：https://github.com/Kong/ai-gateway-plugins（未确认存在）、https://konghq.com/products/kong-ai-gateway（未读取）

---

## 五、限制说明（未能核实项）

1. **star/fork/提交数**均为本次会话读取 GitHub 页面时的快照值，非持续追踪数据；各仓库"最近提交日期"未在读取内容中捕获，仅能确认提交历史持续存在、项目处于活跃维护状态。
2. **Higress 与 Kong AI Gateway** 的页面读取失败，其全部数据（star、功能、技术栈、活跃度）未能核实，对比表中未包含，报告中相关描述仅标注为一般背景参考。
3. 各项目的"审计日志"能力大多未在主页明确展开，表中标注为"未核实"，需进一步阅读各项目文档（docs 目录/官网）确认。
4. 后续最小步骤：重试读取 higress 与 Kong 相关页面（或由用户提供可访问的镜像/文档链接），并补充各项目最近提交时间与审计日志细节。