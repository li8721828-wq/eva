# 大模型中转算力池 — 技术架构线调研报告

> **调研状态声明（重要）**：本次执行中，web_search 工具未返回任何搜索结果，read_web_page 对绝大多数目标 URL 读取超时，仅有 LiteLLM 官方架构文档一篇成功读取并验证。因此本报告严格执行「已验证事实」与「合理推断」二分：**仅第 2 章为已验证事实（附来源 URL）**，其余章节为合理推断，**未经网页来源验证**，引用前须补证。未验证的论断一律标注「（推断，未验证）」。

---

## 1. 调研方法与验证状态

| 步骤 | 结果 |
|---|---|
| web_search 检索（多轮、多关键词） | 全部返回「No public web results were found」，检索服务不可用 |
| read_web_page 验证 | LiteLLM 架构文档 1 篇成功；其余（多篇）超时失败 |
| 已验证来源数 | 1（https://docs.litellm.ai/docs/proxy/architecture） |

结论：本报告只能支撑「LiteLLM Gateway 架构」这一条已验证事实链；其余技术环节（语义缓存、KV cache 复用、弹性伸缩、倍率计价等）仅有通用推理，需在检索服务恢复后补证。

---

## 2. 已验证事实：LiteLLM Gateway 的请求生命周期架构

来源：https://docs.litellm.ai/docs/proxy/architecture （2026-09-02 读取）

LiteLLM 是当前最主流的大模型网关/中转开源项目之一，其官方文档对请求生命周期做了完整描述，可作为「中转算力池」技术架构的基准样本：

1. **统一入口与认证**：客户端（OpenAI SDK、LangChain、curl）以 `Authorization: Bearer sk-...` 接入 LiteLLM Gateway（默认端口 4000）。虚拟密钥（virtual key）校验采用「先缓存、缓存未命中再查数据库」的两级策略。
2. **预算检查与限流**：在路由之前执行认证与预算检查；限流按 rpm（每分钟请求数）/ tpm（每分钟 token 数）在 key、user、team、server 四个维度分别计数。
3. **存储层**：PostgreSQL 存放 keys 与 spend（用量/计费数据）；Redis 承担 key 缓存与限流计数器。
4. **路由层**：Router 组件负责负载均衡、fallback（故障转移）与重试——即多供应商容灾的核心机制。
5. **协议转换**：litellm SDK 负责把 OpenAI 格式请求翻译为各供应商原生格式，对外保持 OpenAI 格式统一，支持 OpenAI、Anthropic、Bedrock、Vertex 等 100+ 供应商。
6. **异步计量**：响应返回客户端后，spend 记录、限流计数、日志回调全部在后台异步任务中执行；除缓存未命中时的数据库读取外，所有数据库事务均为异步后台任务——这是保证网关高吞吐的关键设计。

由此可确认的架构模式（已验证）：中转网关 = 统一鉴权 + 多维度限流 + 路由/fallback/重试 + 协议翻译 + 异步计量，其中 PostgreSQL + Redis 是典型的「持久化账本 + 热路径缓存」组合。

---

## 3. 合理推断（未经网页验证，需补证）

以下内容基于通用工程常识与行业公开讨论的合理推断，**不代表已验证事实**。每个主题后附「需补证来源」建议。

### 3.1 统一 API 网关与协议转换（推断，未验证）
- 推断：主流中转网关普遍采用「对外 OpenAI 兼容格式、对内供应商原生格式」的翻译层，使客户端无需改动即可切换供应商。LiteLLM 已验证支持该模式；one-api/new-api 生态亦普遍宣称兼容 OpenAI 格式。
- 需补证来源：one-api 官方文档、new-api 文档、Higress AI Gateway 文档。

### 3.2 请求路由与负载均衡（推断，未验证）
- 推断：路由策略通常包含：按价格路由（优先低价供应商）、按延迟路由（优先低 P95 延迟）、按可用性路由（健康检查剔除故障上游）、按配额/余量路由（避免上游限流）、按模型能力路由（如长上下文、视觉模型）。
- 需补证来源：OpenRouter 官方文档（其公开宣传「自动选择最佳模型/供应商」）、LiteLLM Router 文档。

### 3.3 多供应商 fallback 与重试策略（推断，未验证）
- 推断：典型策略为「同模型多供应商冗余 + 失败自动切换 + 指数退避重试 + 熔断」。已验证 LiteLLM Router 具备 fallback/retry 能力；具体参数（重试次数、超时、熔断阈值）因实现而异。
- 需补证来源：LiteLLM router 文档、one-api 渠道故障转移文档。

### 3.4 语义缓存与 KV cache 复用（推断，未验证）
- 推断：语义缓存（对相似 prompt 命中缓存响应）在部分网关中以「请求级缓存」形态存在；KV cache 复用（跨请求共享前缀的 prefill 结果）是推理引擎层（如 vLLM 的 prefix caching、SGLang 的 RadixAttention）的能力，网关层通常不直接实现，而是依赖后端推理服务。中转站是否透传/受益于 KV cache 复用取决于其是否自建推理集群。
- 需补证来源：vLLM 文档（prefix caching）、SGLang 文档、各中转站技术博客。

### 3.5 并发与配额管理（推断，未验证）
- 推断：配额管理通常分两层——上游侧（供应商 API 的 rpm/tpm 限制）与下游侧（中转站对用户的套餐/倍率限制）。已验证 LiteLLM 在 key/user/team/server 四维限流；推断 one-api 生态以「令牌分组 + 倍率」实现类似能力。
- 需补证来源：one-api 文档（令牌与倍率）、LiteLLM 限流文档。

### 3.6 计量计费（token 计量、倍率计价）（推断，未验证）
- 推断：计费模型普遍为「按 token 计量 × 模型倍率 × 用户倍率」；供应商原始价格经倍率折算后形成中转站售价，倍率同时用于套餐扣费与渠道成本核算。已验证 LiteLLM 的 spend 记录为异步后台写入 PostgreSQL。
- 需补证来源：one-api/new-api 文档（倍率与充值）、OpenRouter 定价页。

### 3.7 密钥管理与安全隔离（推断，未验证）
- 推断：中转站持有上游供应商密钥（加密存储），对下游用户签发虚拟密钥；虚拟密钥可设额度、过期时间、模型白名单，实现租户隔离。已验证 LiteLLM 采用虚拟密钥 + 缓存优先校验。
- 需补证来源：LiteLLM 虚拟密钥文档、one-api 令牌文档。

### 3.8 弹性伸缩（推断，未验证）
- 推断：纯 API 中转（无自建推理）的伸缩主要靠无状态网关水平扩容 + Redis/PostgreSQL 共享状态；自建推理的算力池（如 SiliconFlow、Together AI）则依赖 GPU 集群调度与推理引擎（vLLM/SGLang）的批处理优化。中转站与推理池在「弹性伸缩」上的技术深度差异显著。
- 需补证来源：SiliconFlow/Together AI 技术博客、vLLM 部署文档。

---

## 4. 未验证关键论断清单（后续补证任务）

| # | 论断 | 期望来源 |
|---|---|---|
| 1 | one-api/new-api 的倍率计价与令牌分组机制 | one-api / new-api 官方文档 |
| 2 | OpenRouter 的供应商路由与自动选择逻辑 | openrouter.ai 文档 |
| 3 | 语义缓存在网关层的实际落地（哪些项目支持） | LiteLLM caching 文档、Higress AI Gateway 文档 |
| 4 | KV cache 复用（prefix caching）在算力池中的实际应用 | vLLM / SGLang 官方文档 |
| 5 | 国内中转站的密钥存储与安全隔离实践 | 相关安全博客、漏洞披露 |
| 6 | 中转网关的弹性伸缩与高可用部署形态 | LiteLLM 部署文档、Kubernetes 案例 |

---

## 5. 结论与下一步

- **已验证**：以 LiteLLM 为代表的网关层架构已确认包含「统一鉴权（虚拟密钥）→ 多维限流（rpm/tpm）→ 路由/fallback/重试 → OpenAI 格式协议翻译 → 异步计量」的完整链路，PostgreSQL + Redis 为典型存储组合。
- **未验证**：语义缓存、KV cache 复用、倍率计价细节、密钥存储安全、弹性伸缩等环节均停留在推断层面。
- **最小下一步**：恢复 web_search 检索服务后重跑检索并逐篇 read_web_page 验证；或由用户直接提供上述「期望来源」URL 列表，本线可立即逐篇读取补证。