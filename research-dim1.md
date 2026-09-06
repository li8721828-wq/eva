# 维度一：大模型 API 中转层（API 中转/网关）调研笔记

> 调研日期：2026-09-03
> 证据等级说明：
> - 【已验证】= 通过 read_web_page 成功读取的官方文档/GitHub 页面原文
> - 【摘要】= web_search 返回的标题/摘要片段（未读取正文，不可作为最终结论）
> - 【推断】= 基于已验证事实的合理推断，未直接核实

---

## 1. 现状总览

中转层（API 网关/中转站）解决的核心问题是：把"上游多个模型提供方"统一为一个 OpenAI 兼容的 API 出口，并叠加路由、计费、限流、负载均衡等运营能力。当前格局分三类：

1. **开源自托管网关**：one-api / new-api（国内中转站主流底座）、LiteLLM Proxy（海外主流，Python 生态）、以及各类小型 Go 网关（如 grok2api）。
2. **商业聚合路由服务**：OpenRouter 模式——单一 API endpoint 聚合数百模型，自动 fallback 与成本最优选择。
3. **"中转站的中转站"**：如 metapi，把多个中转站再聚合为一层（【摘要】GitHub cita-777/metapi：提供中转站定价对比、延迟/成功率实测指标、上游模型目录缓存与品牌分类）。

---

## 2. 开源网关项目

### 2.1 one-api（songquanpeng/one-api）
- 【摘要】GitHub awesome-chatgpt 项目列表描述："LLM API 管理&分发系统，支持 OpenAI、Azure、Anthropic Claude、Google Gemini、DeepSeek、字节豆包……"（来源：https://github.com/uhub/awesome-chatgpt）
- 【摘要】new-api 相关讨论中提及：one-api 于 2023 年 4 月创建，被视为 LLM 网关类项目的源头，后续归属转至 QuantumNous（来源：x.com 搜索结果摘要，**可信度低**，仅作线索）
- 【推断】技术栈为 Go + React + SQLite/MySQL（业内常见说法，**本次未直接核实**）；核心概念为"渠道（Channel）"——每个渠道绑定一个上游供应商，按权重/优先级轮询分发请求（未核实）

### 2.2 new-api（QuantumNous/new-api）
- 【已验证】GitHub 仓库首页（read_web_page 成功，部分内容）："A unified AI model hub for aggregation & distribution. It supports cross-converting various LLMs into OpenAI-compatible, Claude-compatible, or Gemini-compatible formats. A centralized gateway for personal and enterprise model management."——即：统一模型聚合/分发中心，支持把各类 LLM **交叉转换为 OpenAI 兼容、Claude 兼容或 Gemini 兼容格式**，面向个人与企业的集中式网关。（来源：https://github.com/QuantumNous/new-api）
- 【已验证】同一页面部署警告：所有节点必须使用**同一个主数据库和同一个 SESSION_SECRET**，否则 Access Tokens、refresh sessions 与临时认证流程无法一致验证；连接同一 Redis 的节点必须使用**相同的 CRYPTO_SECRET**，否则缓存键摘要不一致。→ 证明 new-api 支持**多节点部署**，架构依赖"共享数据库 + Redis + 会话密钥"，具备令牌/会话安全机制。
- 【摘要】new-api 的典型使用场景是"给客户卖 token 或内部计费记账"（x.com 摘要，可信度低）
- 【推断】new-api 为 one-api 的活跃 fork/延续（多来源提及，但本次仅见低可信度摘要，标记为推断）

### 2.3 LiteLLM Proxy（海外主流网关）
- 【已验证】官方 Quick Start（read_web_page 成功）：LiteLLM Server (LLM Gateway) 提供：
  - **统一接口**：以 OpenAI ChatCompletions & Completions 格式调用 100+ LLM（Huggingface/Bedrock/TogetherAI 等）
  - **成本追踪**：认证、消费追踪与预算
  - **虚拟密钥**（Virtual Keys）
  - **负载均衡**：多模型 + 多 deployment 之间，压测可达 1.5k+ requests/second
  - 安装方式 `uv tool install 'litellm[proxy]'`，要求 Python 3.10+（LiteLLM 1.84.0 起）
  （来源：https://docs.litellm.ai/docs/proxy/quick_start）
- 【已验证】Virtual Keys 文档（read_web_page 成功）：虚拟密钥用于追踪消费、控制模型访问；需要 Postgres（DATABASE_URL）；master key 必须以 `sk-` 开头，可配置于 `config.yaml` 的 `general_settings:master_key` 或环境变量；支持 `POST /key/block` 禁用密钥。（来源：https://docs.litellm.ai/docs/proxy/virtual_keys）
- 【摘要】路由文档：路由策略包括 **Weighted Pick（加权）、Rate Limit Aware（限流感知）、Least Busy（最少繁忙）、Latency Based（延迟）、Cost Based（成本）**；Router 提供多种策略。（来源：https://docs.litellm.ai/docs/routing）
- 【摘要】可按 key/team 定制路由策略（如高优先级 key 用 least-busy，其他用 latency-based），并可配置不同 fallback。（来源：https://docs.litellm.ai/docs/proxy/keys_teams_router_settings）
- 【摘要】负载均衡状态存储在 Redis（redis_password 配置）。（来源：https://docs.litellm.ai/docs/proxy/configs）
- 【摘要】第三方实践文章（2026-06-11）：自托管 LiteLLM 作 OpenAI 兼容网关，含 aliases、virtual keys、budgets、load balancing、fallbacks、Langfuse 追踪。（来源：Medium, https://medium.com/@adnanmasood/using-litellm-as-an-open-source-llm-proxy-the-llm-gateway-playbook-part-2-c50166ac1446）

### 2.4 OpenRouter（商业聚合，作为模式参考）
- 【已验证】官方 Quickstart（read_web_page 成功）：OpenRouter 通过**单一 API endpoint** 访问数百个 AI 模型；**自动处理 fallback**；为每个请求**选择最具成本效益的选项**；提供三种集成方式：API（完全控制）、Client SDKs、Agent SDK（支持 tool use、循环与状态）；另提供 MCP server（https://mcp.openrouter.ai/mcp）。（来源：https://openrouter.ai/docs/quickstart）
- 【已验证】文档索引 llms.txt（read_web_page 成功）：包含 Quickstart、Batch API（异步批量推理）、Principles、Models、MCP、Terraform Provider；支持把 traces 发送到 ClickHouse、Comet Opik、Datadog、Google BigQuery 等可观测性后端。（来源：https://openrouter.ai/docs/llms.txt）
- 【摘要】官方博客（2026-06-12）："How OpenRouter Model Routing Works"——请求路由覆盖 **70+ providers**，用户可控制 provider 顺序、价格上限（price ceiling）与 fallback 链。（来源：https://openrouter.ai/blog/insights/model-routing/）
- 【摘要】官方博客（2026-06-12）："Provider Failover vs Model Fallbacks"——**provider failover 是自动的；model fallbacks 是 opt-in 的**。（来源：https://openrouter.ai/blog/insights/reliability-failover/）
- 【摘要】Provider Routing 文档：带 tools/tool_choice 的请求会尽力路由到已知支持 tool use 的 provider。（来源：https://openrouter.ai/docs/guides/routing/provider-selection）
- 【摘要】Auto Router 文档：`openrouter/auto` 与 `openrouter/auto-beta` 作为模型 slug 使用，发送该模型名即可自动选择模型。（来源：https://openrouter.ai/docs/guides/routing/routers/auto-router）

### 2.5 其他小型/衍生项目
- 【摘要】metapi（cita-777/metapi）："中转站的中转站"——将分散的 AI 中转站聚合为统一网关，提供中转站定价对比、延迟/成功率实测指标、上游模型目录缓存与品牌分类。（来源：https://github.com/cita-777/metapi）
- 【摘要】grok2api（chenyme/grok2api）：内置 React 管理端的 **Go 网关**。（来源：https://github.com/chenyme/grok2api/blob/main/README.zh-CN.md）

---

## 3. 核心能力梳理

### 3.1 多模型路由
- 【已验证】OpenRouter：自动 fallback + 每请求成本最优选择；【摘要】70+ providers、provider 顺序/价格上限/fallback 链可配置、auto-router（openrouter/auto）。
- 【摘要】LiteLLM：六类路由策略（weighted pick / rate-limit aware / least busy / latency based / cost based），可按 key/team 定制，支持 fallback 配置。
- 【推断】one-api/new-api 系以"渠道"为单位做权重/优先级轮询路由（常见实现，未直接核实）。

### 3.2 Key 管理与计费
- 【已验证】LiteLLM：虚拟密钥（消费追踪、预算、模型访问控制）、master key 管理、`/key/block` 禁用、依赖 Postgres。
- 【已验证】new-api：令牌/会话机制（SESSION_SECRET 影响 Access Tokens 验证），支持多节点共享会话状态。
- 【摘要】new-api 典型场景：对外卖 token、内部计费记账。
- 【推断】one-api 系按 token 用量计费、支持按次/按量/按并发等多种计费模型（常见说法，未核实）。

### 3.3 限流
- 【摘要】LiteLLM 提供 rate-limit aware 路由策略（隐含限流感知能力）。
- 【推断】one-api/new-api 提供基于令牌的速率限制与并发限制（常见说法，未核实）。

### 3.4 负载均衡
- 【已验证】LiteLLM：多模型 + 多 deployment 负载均衡，压测 1.5k+ req/s；【摘要】均衡状态存 Redis。
- 【推断】one-api 系按渠道权重/优先级分配流量。

### 3.5 流式转发
- 【推断】OpenAI 兼容 SSE 流式转发是中转站标配能力（本次未直接核实具体实现）。
- 【已验证】new-api 支持跨协议转换（OpenAI/Claude/Gemini 兼容），隐含协议适配层能力。

---

## 4. 主流实现架构与技术栈

| 项目 | 类型 | 技术栈 | 关键架构点 | 证据等级 |
|---|---|---|---|---|
| LiteLLM Proxy | 开源网关 | Python（uv tool install，Python 3.10+） | Postgres（密钥/消费）+ Redis（负载均衡状态/缓存）+ OpenAI 兼容 API | 【已验证】 |
| new-api | 开源网关 | 未核实（Go 系推断） | 多节点部署：共享主数据库 + SESSION_SECRET + Redis + CRYPTO_SECRET；协议交叉转换（OpenAI/Claude/Gemini） | 【已验证】架构要点；技术栈【推断】 |
| one-api | 开源网关 | Go + React + SQLite/MySQL（【推断】未核实） | 渠道（Channel）+ 令牌（Token）体系 | 【摘要】+【推断】 |
| OpenRouter | 商业聚合 | 托管服务（未公开技术栈） | 单一 API endpoint + 70+ provider 路由 + MCP server + Terraform Provider + 可观测性集成（ClickHouse/Opik/Datadog/BigQuery traces）+ Batch API | 【已验证】文档层面 |
| metapi | 聚合网关 | 未核实 | 中转站定价对比、延迟/成功率实测、上游模型目录缓存 | 【摘要】 |
| grok2api | 小型网关 | Go + React 管理端 | 单模型（Grok）网关 | 【摘要】 |

**架构共性（推断）**：主流中转网关 = 统一协议层（OpenAI 兼容出口）+ 路由/渠道层（多上游）+ 运营层（Key/计费/限流/审计）+ 状态存储（关系库 + Redis）。国内中转站普遍以 one-api/new-api 为底座 + 商业渠道（官方 API 或转售），部署于云服务器（【推断】）。

---

## 5. 已验证事实 / 摘要 / 推断 三清单

### 已验证事实（read_web_page 成功）
1. LiteLLM 是 OpenAI 兼容的 LLM 网关，支持 100+ 模型、虚拟密钥、消费追踪与预算、多部署负载均衡（1.5k+ req/s 压测）、Python 3.10+。
2. LiteLLM 虚拟密钥依赖 Postgres，master key 以 sk- 开头，支持 /key/block 禁用。
3. new-api 支持多节点部署（共享数据库 + SESSION_SECRET + Redis + CRYPTO_SECRET），支持 OpenAI/Claude/Gemini 兼容格式交叉转换。
4. OpenRouter 以单一 API endpoint 聚合数百模型，自动 fallback、成本最优选择，提供 MCP server、Terraform Provider、Batch API、多可观测性后端集成。

### 搜索摘要（未读正文，需后续核实）
1. OpenRouter 路由覆盖 70+ providers，可配 provider 顺序、价格上限、fallback 链（2026-06-12 博客）。
2. OpenRouter provider failover 自动、model fallbacks opt-in。
3. LiteLLM 路由策略：weighted pick / rate-limit aware / least busy / latency based / cost based；可按 key/team 定制。
4. one-api 支持 OpenAI/Azure/Claude/Gemini/DeepSeek/豆包等（awesome-chatgpt 列表描述）。
5. new-api 源自 2023 年 4 月的 one-api（x.com 摘要，可信度低）。
6. metapi、grok2api 等衍生项目功能描述。

### 推断（未核实）
1. one-api 技术栈为 Go + React + SQLite/MySQL；渠道权重轮询路由。
2. one-api/new-api 具备令牌级限流、并发限制、SSE 流式转发。
3. 国内中转站普遍 = one-api/new-api 底座 + 转售渠道。
4. new-api 为 one-api 的活跃延续/fork。

---

## 6. 未核实项与局限（unverified）

1. **read_web_page 部分失败**：GitHub new-api 页面读取被截断（部署警告之后的正文未读到）；openrouter.ai 某页面返回 404；一次页面读取因重定向取消。因此 one-api/new-api 的完整功能清单、计费模型、限流参数**未能核实**。
2. **one-api 技术栈与计费细节**：本次仅获得第三方列表摘要，未读取其 GitHub README。
3. **流式转发实现**：无一手资料，仅推断为标配。
4. **中文来源可信度**：new-api 溯源等说法来自 x.com 搜索摘要，可信度低，仅作线索。
5. **OpenRouter 商业模式细节**（抽成比例、收入规模）本次未核实。

## 7. 下一步建议（最小行动项）

1. 读取 one-api GitHub README（https://github.com/songquanpeng/one-api）核实技术栈、渠道/令牌/计费/限流细节。
2. 读取 new-api README 全文核实渠道、令牌、计费、限流与多节点部署细节。
3. 读取 LiteLLM routing 文档（https://docs.litellm.ai/docs/routing）核实六种路由策略细节。
4. 读取 OpenRouter 两篇博客核实路由机制与商业模式。