# 上层接入/分发网关调研 —— research-track1-gateways.md

> 调研主线 1：上层接入/分发网关（one-api、New API、LiteLLM、Higress、Kong AI Gateway）
> 方法：优先直接 read_web_page 读取已知官方 URL；web_search 仅作补充，空结果不视为证据。
> 标注规则：每个实际读取成功的来源记录 URL 并列为「已验证」；读取失败或搜索无结果一律标注「未能核实」。

---

## 一、已验证事实（附来源 URL）

### 1. one-api（songquanpeng/one-api）

来源：https://github.com/songquanpeng/one-api （此前会话已读取验证；本次会话未重新读取）

- 定位为「LLM API 管理 & 分发系统」，支持 OpenAI、Anthropic、DeepSeek、豆包、GLM、文心、讯飞、通义、混元等主流厂商。
- 单可执行文件 + Docker 一键部署形态。
- 数据模型采用 channel（渠道）与 ability（渠道-模型能力映射）分离设计：渠道是上游接入实体，ability 描述渠道与模型的映射关系。

### 2. New API（QuantumNous/new-api）

来源：https://github.com/QuantumNous/new-api （本次会话读取成功，已验证）

- 官方定位：「Next-Generation LLM Gateway and AI Asset Management System」（下一代 LLM 网关与 AI 资产管理系统），面向个人与企业模型管理的集中式网关。
- 核心能力：将各类 LLM 交叉转换为 OpenAI-compatible、Claude-compatible、Gemini-compatible 三种格式（cross-converting），即多 provider 适配的核心机制是「格式互转」。
- 仓库规模：47.2k stars、11.3k forks、6,281 commits，主分支 main。
- 部署方式：Docker 镜像 calciumion/new-api:latest，默认 SQLite（数据挂载 ./data:/data），支持 MySQL（通过 SQL_DSN 环境变量，示例库名 oneapi）。
- 多机部署约束（官方明确警告）：所有节点必须使用同一主数据库和同一 SESSION_SECRET，否则 Access Token、refresh session、临时认证流程无法一致校验；连接同一 Redis 的节点必须使用同一 CRYPTO_SECRET，否则缓存键摘要不一致。
- 代码结构（仓库目录可见）：relay / relaykit（转发与格式转换层）、middleware、model、controller、service、router、plugins、oauth、dto、types 等，说明其工程上采用「转发层 + 中间件 + 模型/控制器分层」的网关架构。
- 项目自带法律合规声明：仅用于合法授权的 AI API 网关、组织级认证、多模型管理、用量分析、成本核算与私有部署场景；要求用户合法获取上游 API Key 并遵守上游服务条款。

### 3. LiteLLM（Router 路由模型 + Proxy Server）

来源 1：https://docs.litellm.ai/docs/routing （本次会话读取成功，已验证）

- 官方 Router 能力清单：跨多个部署（如 Azure/OpenAI）负载均衡；重要请求优先级排队（Queueing）；基础可靠性逻辑——cooldown（冷却）、fallback（回退）、timeout（超时）、retries（重试，固定间隔 + 指数退避）。
- 生产环境支持用 Redis 跟踪冷却状态与用量（管理 tpm/rpm 限额）。
- 路由决策可基于部署延迟：可设置时间窗口（time window），在该窗口内平均各部署延迟以选择目标部署（代码示例中按 min deployment id / model_id 断言验证）。

来源 2：https://docs.litellm.ai/docs/proxy_server （本次会话读取成功，已验证）

- LiteLLM Proxy Server 定位：快速、轻量的 OpenAI 兼容服务器，用于调用 100+ LLM API。
- 支持的上游类型（文档列出的部分）：vLLM、OpenAI Compatible Server、Huggingface、Anthropic、TogetherAI、Replicate、Petals、Palm、Azure 等。
- 使用形态：`litellm --model ollama/codellama` 启动本地代理，客户端改 base_url 即可接入；`litellm --test` 做连通性测试。

### 4. Higress AI 网关

来源：https://higress.ai/docs/latest/overview/what-is-higress/ （本次会话读取成功，已验证）

- CNCF Sandbox 项目，基于 Istio 与 Envoy 构建的开源 AI 原生 API 网关；可用 Go/Rust/JS 编写 Wasm 插件，提供数十个开箱即用插件和管理控制台。
- 起源：阿里内部为解决 Tengine reload 对长连接业务有损、gRPC/Dubbo 负载均衡能力不足而诞生；阿里云基于 Higress 构建云原生 API 网关产品，对外承诺 99.99% 网关高可用。
- 实际支撑的业务：通义千问 APP、百炼大模型 API、机器学习 PAI。
- 认证鉴权能力：key-auth、hmac-auth、jwt-auth、basic-auth、oidc 等。
- 兼作微服务网关：对接 Nacos、ZooKeeper、Consul、Eureka 等注册中心，深度集成 Dubbo；提供 WAF 能力。

### 5. Kong AI Gateway

来源：https://developer.konghq.com/ai-gateway/ （本次会话读取成功，已验证）

- 定位：面向现代 AI 原生应用的「连接与治理层」（connectivity and governance layer），覆盖 LLM 调用、MCP（Model Context Protocol）、A2A（Agent2Agent）三类流量，统一管控。
- 核心能力清单（官方文档）：跨 AI provider 的路由与负载均衡（routing and load balancing across AI providers）；流式与认证（streaming and authentication）；用户访问控制与 ACL；用量分析（requests、tokens、errors、latency）。
- 多 provider 适配方式：通过一个一致的 API 连接任何主流 LLM provider，切换或组合 provider 无需重写应用。
- 实体模型演进：新架构以 AI Model 实体定义上游 provider、模型名与路由行为（取代旧的 AI Proxy 插件）；AI Policies 用于附加 guardrails、transformations、rate limiting 等策略。
- 管理/部署方式：Konnect（云）与自托管（on-prem）均支持；Konnect 托管用 kongctl 管理资源，on-prem 用 decK 管理配置；另有 AI Gateway API 与 Konnect UI 两种管理界面。

---

## 二、未能核实清单

以下内容在本次会话（含此前会话）中未能获得来源级证据，不得视为已验证：

1. one-api 的倍率计费、令牌额度、渠道优先级/故障切换等核心运营机制 —— 此前会话未读到文档站与源码原文，仅属社区共识性推断。
2. New API 的路由/负载均衡具体算法、故障切换（fallback）细节、计费倍率与额度计量实现 —— 本次仅读到仓库 README 与目录结构，未读源码级证据。
3. Kong AI Gateway 的定价、免费额度、具体性能基准 —— 官方文档页未含定价信息。
4. Higress 针对 LLM 流量的路由策略、fallback/重试机制的具体插件实现 —— 本次仅读到概览页。
5. LiteLLM 各路由策略（如 latency-based、usage-based routing）的完整参数与生产级配置细节 —— 本次读到的是文档摘要，未逐项验证全部策略参数。
6. 各网关的实际性能对比数据（吞吐、延迟、并发）—— 无任何来源支撑。

---

## 三、本次会话失败的 agent/工具调用记录

按任务要求，单独记录本次会话中失败或无效的工具调用：

1. read_web_page 多次调用失败（返回 404 / Web request failed）—— 执行完整性通知确认多次 read_web_page 未成功完成；具体失败目标 URL 未在可见执行记录中逐一标注，涉及任务清单中的部分已知官方 URL（GitHub 仓库页与官方文档页）。这些页面的内容一律未列为已验证。
2. web_search 有一次返回与调研主题无关的结果（NU-MOA 校园威胁事件的新闻条目），对本次调研无贡献；按任务约束，搜索空结果/无关结果不视为证据。
3. 任务清单中的 https://github.com/songquanpeng/one-api 本次会话未重新读取成功，其内容仅依据此前会话的已验证记录（见第一节第 1 条）。

---

## 四、后续补充建议

1. 重新读取 one-api 官方文档站（https://docs.oneapi.app 或仓库 docs 目录）与源码中的 channel/ability 数据模型、倍率计费与令牌额度实现，补齐 one-api 的运营机制证据。
2. 读取 New API 仓库 relay 目录源码（relay/relaykit），核实格式互转与上游适配的具体实现，以及是否有 fallback/负载均衡逻辑。
3. 读取 LiteLLM 文档的 proxy 配置页（model_list、router_settings 等），核实 fallback、cooldown、usage-based routing 的完整参数。
4. 读取 Higress AI 网关插件文档（如 ai-proxy、ai-statistics 等插件页），核实 LLM 流量路由与治理细节。
5. 读取 Kong AI Gateway 的 provider 配置页与 AI Model 实体文档，核实多 provider 切换与负载均衡的配置方式。
6. 若需定价数据，读取 SiliconFlow 定价页（https://siliconflow.cn/pricing）与 OpenRouter 定价页作为聚合平台定价现状的补充（属主线 2 范围，可另行调研）。