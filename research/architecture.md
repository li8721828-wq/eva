# 统一网关技术架构调研笔记（LLM API 中转/聚合/路由平台）

> 调研时间：2026-09-02
> 调研对象：OneAPI、New API、LiteLLM Proxy、OpenRouter 等开源项目文档与代码仓库
> 说明：本文区分「已验证事实」（来自本次调研中实际读取到的文档/仓库原文）与「推断/观点」（基于已验证事实的合理推理或一般性知识，未经本次调研直接证实）。

---

## 0. 证据来源与验证状态

### 已验证来源（本次调研实际读取到内容）
| 来源 | URL | 验证内容 |
|---|---|---|
| liteLLM 文档 - 负载均衡 | https://docs.litellm.ai/docs/proxy/load_balancing | 路由策略、部署优先级、Redis 多实例状态、RPM/TPM 限制 |
| liteLLM 文档 - 缓存 | https://docs.litellm.ai/docs/proxy/caching | 缓存类型清单、虚拟 Key 认证缓存、语义缓存要求 |
| liteLLM 文档 - 故障转移 | https://docs.litellm.ai/docs/proxy/reliability | Fallback 机制、内容策略/上下文窗口 Fallback |
| New API README（GitHub） | https://raw.githubusercontent.com/Calcium-Ion/new-api/main/README.md | 项目定位、环境变量（请求体限制、Azure 版本、错误日志、Pyroscope） |
| One API README（GitHub） | https://raw.githubusercontent.com/songquanpeng/one-api/main/README.md | 项目定位、合规声明、环境变量（轮询间隔、批量更新） |

### 未验证/失败来源
- **OpenRouter 文档**（https://openrouter.ai/docs）：本次访问失败（重定向被取消），未能获取页面证据。本笔记中涉及 OpenRouter 的内容一律标注为「推断/观点」，不构成已验证事实。
- 多次网络搜索未返回结果（搜索引擎无结果），因此未能补充 OpenRouter、硅基流动、火山方舟等平台的官方文档证据。

---

## 1. 多供应商接入与路由（协议转换、OpenAI 兼容、模型映射）

### 1.1 已验证事实
- **One API 的核心定位**：README 原文「通过标准的 OpenAI API 格式访问所有的大模型，开箱即用」，即对外暴露 OpenAI 兼容接口，内部对接多家供应商。项目同时声明使用者须遵守 OpenAI 使用条款及中国《生成式人工智能服务管理暂行办法》（不得对境内公众提供未备案的生成式 AI 服务）。
- **New API 的定位**：README 原文自称「Next-Generation LLM Gateway and AI Asset Management System」（下一代 LLM 网关与 AI 资产管理平台），强调组织级认证、多模型管理、用量分析、成本核算、私有化部署；并声明用户须合法获取上游 API Key、遵守上游服务条款。
- **LiteLLM 的模型映射机制**：通过 `model_list` 配置，将对外 `model_name`（如 `gpt-3.5-turbo`）映射到多个上游部署（`litellm_params.model` 如 `azure/<deployment-name>`，外加 `api_base`、`api_key`、`rpm` 等参数）；同一 `model_name` 可对应多个供应商部署，实现"一个对外模型名 → 多个上游实例"。
- **LiteLLM 模型组别名**：`model_group_alias: {"gpt-4": "gpt-3.5-turbo"}` 可将请求 `gpt-4` 路由到 `gpt-3.5-turbo` 的部署组（模型降级/替换的一种显式配置手段）。

### 1.2 推断/观点
- 协议转换层的一般做法：网关对外统一 OpenAI 格式（`/v1/chat/completions`），内部将请求翻译为各供应商原生格式（Anthropic Messages API、Google Gemini API、各家国内厂商格式等），再把上游响应归一化为 OpenAI 格式返回。此机制与 One API「标准 OpenAI 格式访问所有大模型」的定位一致，但具体转换实现细节（如工具调用、多模态字段映射）未在本次读取的文档中直接证实。
- 模型映射是中转平台的核心抽象：对外模型名（模型组）与上游"渠道/部署"解耦，是后续负载均衡、故障转移、成本路由的前提。LiteLLM 的 `model_list`/`model_group_alias` 已验证，OneAPI/New API 的"渠道（Channel）"机制为同类设计（推断，未直接读取其源码）。
- 推断：主流平台普遍支持"模型别名"（同一模型不同价格/供应商的别名）与"隐藏模型"（LiteLLM 文档提到 Usage Hide Alias Models，说明存在别名隐藏能力）。

---

## 2. 负载均衡与故障转移策略

### 2.1 负载均衡（已验证，来源：liteLLM 负载均衡文档）
LiteLLM Proxy 内置 Router，将请求自动分发到同一模型的多个部署。文档列出的路由策略：

| 策略 | 行为 | 适用场景（文档原文） |
|---|---|---|
| simple-shuffle（默认，推荐） | 随机分发 | 通用，负载均匀 |
| least-busy | 路由到活跃请求最少的部署 | 高并发 |
| usage-based-routing | 路由到当前 RPM/TPM 用量最低的部署 | 需要均匀遵守速率限制（文档标注"对性能不友好"） |
| latency-based-routing | 路由到响应最快的部署 | 延迟敏感应用 |
| cost-based-routing | 路由到成本最低的部署 | 成本敏感应用 |

- **部署优先级**：可通过 `order` 参数指定部署优先级（Deployment Ordering）。
- **多实例部署**：使用多个 LiteLLM Proxy 实例（Kubernetes、自动扩缩容）时，负载均衡状态存放在 Redis（`redis_host`/`redis_password`/`redis_port`），实现跨实例共享路由状态。
- **重试与超时**：`num_retries`、`timeout` 为 Router 级配置项。
- **加密内容亲和性**：`encrypted_content_affinity` 可将含加密内容的请求固定路由到创建该内容的部署，避免 `invalid_encrypted_content` 错误，其余请求正常负载均衡。

### 2.2 故障转移（已验证，来源：liteLLM 故障转移文档）
- Fallback 是 LiteLLM 的自动故障转移机制：某次调用在 `num_retries` 次重试后仍失败，则回退到另一个模型组/部署。典型配置 `fallbacks=[{"gpt-3.5-turbo": ["gpt-4"]}]`（从主模型回退到备用模型）。
- 文档还提到两类特殊 Fallback：
  - **Content Policy Fallbacks**：主供应商以内容策略（content-policy）错误拒绝请求时切换；
  - **Context Window Fallbacks**：通过预调用检查（pre-call checks）发现上下文超窗时切换。
- 文档标题即「Fallbacks (Provider Failover)」，明确这是供应商级故障转移能力。

### 2.3 推断/观点
- OneAPI/New API 的渠道机制（多"渠道"对应同一模型、渠道可用性测试、自动禁用失效渠道）与 LiteLLM 的部署组+Fallback 是同一类设计；One API README 中 `POLLING_INTERVAL`（批量更新渠道余额并测试可用性的请求间隔）已验证，说明其存在"渠道健康检查"机制，但渠道自动切换的详细策略未直接读取源码证实。
- 推断：生产级网关的故障转移通常分层：单部署重试（num_retries）→ 同模型组内切换部署 → 跨模型组 Fallback（降级模型）。LiteLLM 文档结构支持这一分层推断。
- 推断：成本优先/延迟优先/可用性优先的调度策略，对应 LiteLLM 的 cost-based-routing / latency-based-routing / simple-shuffle+fallback 组合，这是"算力池"动态调度的核心机制。

---

## 3. API Key 管理与配额/限流控制

### 3.1 已验证事实
- **LiteLLM 虚拟 Key 认证缓存**：Proxy 验证虚拟 Key（客户 API Key）时，结果缓存在 Redis，避免每次请求都查询数据库（缓存文档明确说明）。
- **LiteLLM 部署级速率限制**：`model_list` 中每个部署可配置 `rpm`（每分钟请求数）；"Enforce Model Rate Limits" 模式下，超过 RPM/TPM 限制的请求在到达 LLM 供应商之前即被拦截并返回 429；支持输入/输出分开限制（`itpm`/`otpm`）。
- **One API 配额体系**：README 提及用户额度（quota）与批量更新聚合：`BATCH_UPDATE_ENABLED=true` 启用数据库批量更新聚合（缓解连接数过多问题），代价是用户额度更新存在延迟；`POLLING_INTERVAL` 控制批量更新渠道余额与测试可用性的请求间隔。
- **New API 组织级能力**：README 提及组织级认证、用量分析、成本核算（usage analytics, cost accounting）。
- **LiteLLM Enterprise**：负载均衡文档末尾提及企业版含 SSO/SAML、审计日志、支出追踪（spend tracking）、多团队管理、guardrails（护栏）。

### 3.2 推断/观点
- 令牌桶（token bucket）是限流最常见的实现算法，但**本次读取的文档中未出现"令牌桶"字样**；LiteLLM 的 rpm 限制与 429 行为可视为"固定窗口/滑动窗口计数"类实现，具体算法需查源码确认（推断）。
- 多实例场景下限流状态必须共享，Redis 计数是通行做法；LiteLLM 已验证用 Redis 存负载均衡状态，推断限流计数同样依赖 Redis（推断）。
- 推断：中转平台的 Key 体系通常分三层——上游供应商 Key（网关持有）、平台虚拟 Key（发给终端用户）、渠道 Key（绑定具体供应商）；虚拟 Key 与额度绑定，LiteLLM 虚拟 Key 缓存机制已验证，三层结构为推断。
- 推断：计费计量与限流共用同一套 token 计数（prompt/completion 分开计量），LiteLLM 的 spend tracking 存在已验证，具体计量口径（缓存命中是否计费、流式 token 统计）未证实。

---

## 4. 缓存与流式响应（SSE）处理

### 4.1 缓存（已验证，来源：liteLLM 缓存文档）
- LiteLLM 缓存系统存储并复用 LLM 响应，以节省成本、降低延迟；相同请求第二次命中缓存时不再调用上游 API。
- 支持的缓存后端清单：内存缓存、磁盘缓存、Redis、Qdrant 语义缓存、Redis 语义缓存、Valkey 语义缓存、S3 桶缓存、GCS 桶缓存。
- 语义缓存的部署要求：Valkey 需运行 `valkey-search` 模块（`MODULE LIST` / `FT._LIST` 可检查）；文档明确 RediSearch 和 RedisVL **不是必需**。
- 文档警告：对多轮 Agent 流量（multi-turn agentic traffic）启用缓存前需谨慎评估（语义缓存可能对这类工作负载不适用）。
- 虚拟 Key 认证缓存（见第 3 节）也属于缓存体系的一部分。

### 4.2 流式响应（SSE）
- **本次调研未获取到 SSE 处理的直接文档证据**（LiteLLM 缓存/负载均衡/故障转移三篇文档均未详细展开流式转发细节）。
- 推断/观点：
  - 流式响应（SSE，`stream: true`）要求网关逐块（chunk）透传上游事件，不能等完整响应再转发，否则失去流式意义；
  - 缓存与流式天然冲突：缓存通常针对完整响应，流式请求要么跳过缓存，要么缓存完整响应后按块回放（需特殊实现）；
  - OneAPI/New API 均宣称 OpenAI 兼容，推断其支持流式转发，但**未经本次调研直接证实**；
  - 流式场景下的计费计量需在流结束时按累计 token 结算，推断与限流计数共用管道。

---

## 5. 可观测性（日志/监控/计费计量）

### 5.1 已验证事实
- **New API**：环境变量 `ERROR_LOG_ENABLED`（错误日志开关）、`PYROSCOPE_URL` / `PYROSCOPE_APP_NAME`（接入 Pyroscope 持续性能剖析服务）；`AZURE_DEFAULT_API_VERSION`（Azure 上游 API 版本，默认 `2025-04-01-preview`）；请求体大小限制（超限返回 413，默认 32，防 zip 炸弹/超大请求耗尽内存）。
- **One API**：渠道余额轮询与可用性测试（`POLLING_INTERVAL`）、批量更新聚合（`BATCH_UPDATE_ENABLED`/`BATCH_UPDATE_INTERVAL`）。
- **LiteLLM Enterprise**：审计日志、支出追踪（spend tracking）、多团队管理（见第 3 节）。

### 5.2 推断/观点
- 计费计量的一般模型：按 token 计量（输入/输出分开计价），结合渠道成本价与对外售价计算毛利；LiteLLM 的 spend tracking 存在已验证，具体计量字段未证实（推断）。
- 监控体系：推断常见组合为 Prometheus + Grafana 采集请求量、延迟、错误率、token 用量，以及 Pyroscope 类持续剖析工具做性能分析（New API 已证实接入 Pyroscope，Prometheus 组合为推断）。
- 日志体系：推断包含请求/响应日志（含脱敏）、错误日志（New API 的 ERROR_LOG_ENABLED 已验证）、审计日志（LiteLLM Enterprise 已验证存在）。

---

## 6. 结论

### 已验证结论
1. 统一网关的对外形态是 OpenAI 兼容 API（One API 明确定位「标准 OpenAI API 格式访问所有大模型」），对内通过模型映射（LiteLLM `model_list` + `model_group_alias`）对接多供应商。
2. 负载均衡策略已形成成熟分类：随机（simple-shuffle）、最少活跃（least-busy）、用量感知（usage-based）、延迟优先（latency-based）、成本优先（cost-based），且支持部署优先级与 Redis 共享状态的多实例部署（LiteLLM）。
3. 故障转移是显式的一等能力：重试后跨模型组 Fallback、内容策略 Fallback、上下文窗口 Fallback（LiteLLM）。
4. 限流在到达上游前执行（超限直接 429），支持部署级 RPM/TPM 与输入/输出分离限制；虚拟 Key 认证结果可缓存于 Redis 减少数据库压力（LiteLLM）。
5. 缓存体系完整：内存/磁盘/Redis/语义缓存（Qdrant、Redis、Valkey）/对象存储（S3、GCS）；语义缓存依赖向量检索模块；文档明确警告多轮 Agent 流量慎用缓存。
6. 可观测性组件：错误日志开关、Pyroscope 性能剖析（New API）、渠道余额轮询与批量更新（One API）、审计日志与支出追踪（LiteLLM Enterprise）。
7. 合规是项目自带的显式约束：One API 与 New API 均在 README 声明须遵守上游 ToS 与中国生成式 AI 备案法规。

### 推断/观点（未经本次调研直接证实）
1. 协议转换层（OpenAI ↔ 各供应商原生格式）是网关的核心内部组件，但转换细节未在已读文档中展开。
2. 令牌桶等具体限流算法未在已读文档中出现，需查源码确认；Redis 计数限流为多实例场景的通行做法。
3. SSE 流式转发、流式计费、缓存与流式互斥处理的具体实现未证实。
4. OpenRouter 的架构（其路由/定价/供应商管理机制）本次未能访问文档，无法给出已验证结论。
5. 云厂商官方聚合（火山方舟、阿里云百炼等）与民间中转站的架构差异、市场格局数据，本次搜索未获得可用结果，属于证据缺口。

### 证据缺口与后续建议
- 需补充读取：OpenRouter 官方文档（本次访问失败）、OneAPI/New API 源码（限流算法、SSE 转发、渠道切换逻辑）、LiteLLM 路由策略详解页（Routing）与流式处理文档。
- 需补充搜索：硅基流动、火山方舟、阿里云百炼、AWS Bedrock、Azure OpenAI 的官方架构文档与定价页（本次搜索引擎多次返回无结果）。

---

## 7. 来源 URL 清单

1. liteLLM 负载均衡：https://docs.litellm.ai/docs/proxy/load_balancing
2. liteLLM 缓存：https://docs.litellm.ai/docs/proxy/caching
3. liteLLM 故障转移（Fallbacks）：https://docs.litellm.ai/docs/proxy/reliability
4. New API README：https://raw.githubusercontent.com/Calcium-Ion/new-api/main/README.md
5. One API README：https://raw.githubusercontent.com/songquanpeng/one-api/main/README.md
6. OpenRouter 文档（访问失败，未采用）：https://openrouter.ai/docs