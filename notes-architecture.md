# 中转算力池技术架构调研笔记（子任务 3：技术架构）

> 调研范围：统一网关层（API 兼容层、OpenAI 协议适配）、路由与负载均衡策略、缓存层（prompt 缓存）、并发与限流、多租户隔离、账单与计量系统、密钥安全（用户密钥托管与代理转发）。
> 说明：本笔记基于本次会话中已成功读取的开源项目文档（LiteLLM、one-api、new-api、Portkey）整理；Higress、APISIX、Kong 等项目的专项页面在本轮调研中未能访问成功（见文末"未能核实"清单），相关条目仅作一般性描述并明确标注。

---

## 1. 总体架构分层（综合各项目文档的共性模式）

典型中转算力池（LLM API 网关/聚合平台）按请求生命周期可分为以下层次：

```
客户端 (OpenAI SDK / LangChain / curl)
        │  Authorization: Bearer sk-...
        ▼
┌─────────────────────────────────────────────┐
│ ① 统一网关层（API 兼容层 / 协议适配）          │
│    - 统一入口：OpenAI 兼容 /chat/completions  │
│    - 协议转换：OpenAI ↔ Claude / Gemini / 各家原生格式
└─────────────────────────────────────────────┘
        ▼
┌─────────────────────────────────────────────┐
│ ② 认证与多租户层（虚拟密钥 / 用户/团队/配额）   │
│    - 虚拟 key 校验（缓存优先，DB 兜底）         │
│    - 预算检查、配额、速率限制（rpm/tpm）        │
└─────────────────────────────────────────────┘
        ▼
┌─────────────────────────────────────────────┐
│ ③ 路由层（Router）                           │
│    - 负载均衡、故障转移、重试、按价格/延迟/可用性路由
└─────────────────────────────────────────────┘
        ▼
┌─────────────────────────────────────────────┐
│ ④ 上游适配层（Provider 翻译）                 │
│    - 将统一请求翻译为各家 provider 原生请求     │
│    - 流式响应（SSE）透传与超时控制              │
└─────────────────────────────────────────────┘
        ▼
      上游 LLM 提供商（OpenAI / Anthropic / 各家）
        │
        ▼（异步后台）
┌─────────────────────────────────────────────┐
│ ⑤ 计量与账单层（异步 spend logging）          │
│    - 用量记录、费用计算、限流计数、审计日志      │
└─────────────────────────────────────────────┘
```

**依据（已核实）**：LiteLLM 官方文档 "Life of a Request"（https://docs.litellm.ai/docs/proxy/architecture）明确描述该请求链路：认证与预算检查 → 虚拟 key（缓存优先、DB 未命中时回源）→ 限流（key/user/team/server 的 rpm/tpm）→ Router（负载均衡、fallbacks、重试）→ Provider 翻译（OpenAI 格式进、OpenAI 格式出）→ 响应返回后异步执行 spend logging、限流计数与日志回调。

---

## 2. 统一网关层（API 兼容层、OpenAI 协议适配）

### 2.1 核心职责
- **统一 API 形态**：对外暴露 OpenAI 兼容接口（`/v1/chat/completions`、`/v1/embeddings` 等），让客户端无需改动即可切换不同上游模型。
- **协议双向转换**：将 OpenAI 格式请求翻译为上游原生格式（Anthropic Messages API、Google Gemini、各家国内厂商格式等），并把上游响应（含流式 SSE）翻译回 OpenAI 格式。

### 2.2 已核实的项目实现
| 项目 | 协议适配方式 | 来源 |
|---|---|---|
| LiteLLM Gateway | "Provider translation" 层：litellm SDK 统一转换，OpenAI 格式进、OpenAI 格式出，支持 100+ provider | https://docs.litellm.ai/docs/proxy/architecture |
| one-api | "统一 API 适配"：多模型统一为 OpenAI 协议，用于 key 管理与二次分发；单可执行文件 + Docker 部署 | https://github.com/songquanpeng/one-api |
| new-api | "cross-converting various LLMs into OpenAI-compatible, Claude-compatible, or Gemini-compatible formats"（多协议输出兼容） | https://github.com/QuantumNous/new-api |
| Portkey Gateway | "Route to 1,600+ LLMs ... with 1 fast & friendly API"（统一 API 路由 1600+ 模型） | https://github.com/Portkey-AI/gateway |

### 2.3 流式与超时处理（已核实）
- new-api 文档提及流式场景细节：非流式上游通常在生成完成后才发送响应头，因此需预留 headroom；`STREAMING_TIMEOUT`（流式超时秒数，默认 300）与 `STREAM_SCANNER_MAX_BUFFER_MB`（流式扫描器单行最大缓冲，防止超长行撑爆内存）等配置项，说明中转网关需专门处理 SSE 流式透传的超时与缓冲问题。来源：https://github.com/QuantumNous/new-api

---

## 3. 路由与负载均衡策略

### 3.1 已核实的 LiteLLM Router 能力（https://docs.litellm.ai/docs/proxy/architecture）
- **负载均衡**：请求在多个上游 channel/provider 之间分发。
- **故障转移（fallbacks）**：上游失败时自动切换到备用 provider。
- **重试（retries）**：对可重试的失败自动重试。
- 路由决策与 provider 翻译分离：Router 负责"选哪个上游"，翻译层负责"怎么调上游"。

### 3.2 已核实的 one-api channel/ability 机制（https://github.com/songquanpeng/one-api）
- 每个"渠道（channel）"对应一个上游接入点，渠道与所支持的模型通过 `ability` 表建立映射关系（一条记录 = 某渠道支持某模型）。
- 路由即"按模型找可用渠道"：请求到来时根据目标模型查询 ability 表得到候选渠道集合，再做负载均衡选择。
- 运维要点（官方 FAQ）：删除 channel 时必须同步清理 ability 表中对应记录，否则会触发"数据库一致性已被破坏"的校验错误——说明该架构以 ability 表作为路由索引，一致性校验是路由正确性的前提。

### 3.3 路由维度（综合推断，标注级别）
- **按价格路由**：优先选择单价/倍率更低的渠道（one-api 类系统支持按渠道倍率计价，推断其路由可结合成本；未在本轮资料中直接核实到"按价格自动路由"的开关）。
- **按延迟/可用性路由**：LiteLLM 支持基于延迟与健康状态的 router 策略（文档架构页未展开细节，属一般性能力描述，未逐项核实）。
- **按配额路由**：结合虚拟 key 的 rpm/tpm 限额与团队配额做前置过滤（LiteLLM 已核实有限流层，但"按配额路由"的具体策略未核实）。

---

## 4. 缓存层（prompt 缓存）

### 4.1 已核实内容
- LiteLLM 架构页确认存在 **Redis 缓存**，用途为：虚拟 key 缓存（减少 DB 读）、限流计数器（rate-limit counters）。来源：https://docs.litellm.ai/docs/proxy/architecture
- 该文档同时说明：除 key 缓存未命中时的 DB 回源外，其他 DB 事务均在后台异步执行——即缓存层承担了关键路径上的读放大削减。

### 4.2 未能核实 / 需补充调研
- **语义 prompt 缓存（如 GPTCache 类、或上游自带的 prefix caching）**：本轮资料未覆盖。中转层是否做 prompt 缓存、如何做缓存键（精确前缀 vs 语义相似）、缓存命中计费如何处理，均未核实。
- 建议后续补充：GPTCache 项目、各云厂商（如 Anthropic prompt caching、DeepSeek 上下文缓存）在中转场景的透传与计费处理。

---

## 5. 并发与限流

### 5.1 已核实的 LiteLLM 限流模型（https://docs.litellm.ai/docs/proxy/architecture）
- 限流维度：`rpm`（每分钟请求数）/ `tpm`（每分钟 token 数），作用域覆盖 **key、user、team、server** 四级。
- 实现：限流计数器存放在 Redis，与 key 缓存同层。
- 认证与预算检查在请求进入路由前执行（"Auth and budget checks" 位于请求链路最前段）。

### 5.2 并发控制（部分核实 + 推断）
- new-api 的流式超时与缓冲配置（见 2.3）间接说明并发场景下的资源保护手段。
- 具体并发模型（连接池、每渠道并发上限、队列）在本轮资料中未直接核实，标注为待补充。

---

## 6. 多租户隔离

### 6.1 已核实的 LiteLLM 租户模型（https://docs.litellm.ai/docs/proxy/architecture）
- 数据模型：`keys`、`teams`、`spend` 存于 PostgreSQL；虚拟 key 关联用户/团队。
- 隔离维度：key/user/team 三级均有独立限流与预算（budget）控制；spend 按 key/team 记账。
- 认证前置：每个请求先做 key 校验与预算检查，未通过即拒绝，实现租户间的配额隔离。

### 6.2 已核实的 one-api 租户模型（https://github.com/songquanpeng/one-api）
- 定位为 "key 管理与二次分发" 系统：管理员配置上游渠道，用户获得平台签发的 key 使用，天然形成"平台-用户"租户结构。
- 数据一致性校验（ability 表）保证渠道维度数据正确，间接保障多租户下路由结果可靠。

### 6.3 推断与待补充
- 数据隔离（各租户用量数据可见性边界）、管理端 vs 用户端权限模型的具体实现未在本轮资料中核实。

---

## 7. 账单与计量系统

### 7.1 已核实的 LiteLLM 计量模型（https://docs.litellm.ai/docs/proxy/architecture）
- **异步记账**：响应返回客户端后，spend logging、限流计数、日志回调全部在后台异步任务中执行——计量不阻塞主请求路径。
- 存储：PostgreSQL 存 `spend` 数据；Redis 存限流计数。
- 预算（budget）与用量（spend）联动：认证阶段即检查预算，形成"先校验、后放行、异步记账"的闭环。

### 7.2 已核实的 one-api 计量模型（https://github.com/songquanpeng/one-api）
- 渠道支持"倍率"计价（项目定位含"计费"能力，README 描述为 key 管理与二次分发系统，支持统一 API 适配；具体倍率/充值细节未在本轮页面中逐项核实）。

### 7.3 待补充
- 计费公式（token 数 × 模型单价 × 渠道倍率）、充值体系、账单导出、对账机制的具体实现细节未核实。

---

## 8. 密钥安全（用户密钥托管与代理转发）

### 8.1 已核实的模型
- **虚拟 key 机制（LiteLLM）**：用户持有平台签发的虚拟 key（`sk-...`），平台侧将虚拟 key 映射到上游真实凭据；虚拟 key 缓存于 Redis、DB 兜底。真实上游 key 不暴露给终端用户。来源：https://docs.litellm.ai/docs/proxy/architecture
- **代理转发（one-api / new-api）**：平台统一持有各渠道上游 key，用户只与平台交互，平台代理转发到上游——即"key 托管 + 代理转发"模式。来源：https://github.com/songquanpeng/one-api 、https://github.com/QuantumNous/new-api

### 8.2 推断与风险点（标注为推断）
- 上游 key 的加密存储（静态加密）、密钥轮换、审计（谁在何时用了哪个渠道）等细节未在本轮资料中核实，属于中转平台安全审计的重点，建议后续专项调研。
- 风险提示：密钥托管模式下，平台持有全部上游凭据，平台侧泄露即全量泄露；这是中转站模式的固有风险点。

---

## 9. 来源清单（本轮已核实）

| 来源 | 内容 | 状态 |
|---|---|---|
| https://docs.litellm.ai/docs/proxy/architecture | LiteLLM "Life of a Request"：认证/预算、虚拟 key、限流、Router、Provider 翻译、异步计量 | ✅ 已读取 |
| https://github.com/songquanpeng/one-api | one-api：统一 API 适配、key 管理与二次分发、ability 表路由、一致性校验 | ✅ 已读取 |
| https://github.com/QuantumNous/new-api | new-api：多协议兼容输出、流式超时与缓冲配置 | ✅ 已读取 |
| https://github.com/Portkey-AI/gateway | Portkey：AI Gateway、1600+ LLM 路由、guardrails | ✅ 已读取 |

---

## 10. 未能核实清单（unverified）

以下内容在本轮调研中**未能核实**（web 搜索无结果、文档 URL 返回 404），仅作一般性常识描述，**不得作为结论引用**，需后续补充：

1. **Higress AI 网关**（阿里）：AI 网关插件、token 限流、多模型路由等细节——官方文档页访问失败（404），未核实。
2. **Apache APISIX AI 插件**：ai-proxy / ai-prompt-template 等插件细节——官方文档页访问失败（404），未核实。
3. **Kong AI Gateway**：AI Proxy 插件、provider 适配细节——未核实。
4. **prompt 语义缓存**（GPTCache 等）：中转层 prompt 缓存的实现与计费处理——未核实。
5. **按价格/延迟自动路由的具体策略参数**：LiteLLM 架构页未展开，未核实。
6. **密钥静态加密、审计日志细节**：未核实。
7. **商业平台（OpenRouter、SiliconFlow 等）的架构细节**：属其他子任务范围，本笔记未涉及。

> 后续最小步骤：重试访问 higress.io 与 apisix.apache.org 的 AI 文档（或直接读取对应 GitHub 仓库 README），补齐 1-3 项；针对 prompt 缓存与密钥加密做专项搜索。