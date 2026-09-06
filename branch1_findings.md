# 分支一调研：大模型 API 中转/聚合网关技术现状

> 调研对象：OneAPI（songquanpeng/one-api）、New API（QuantumNous/new-api）、LiteLLM、Higress AI 网关
> 调研维度：架构、路由策略、负载均衡、故障切换、Key/额度管理与计费、多 provider 适配方式、作为"算力池"接入层的角色
> 报告日期：2026-09-03

---

## 0. 调研方法与证据状态（先读这一节）

**执行过程（如实记录）：**

| 动作 | 对象 | 结果 |
|---|---|---|
| read_web_page | https://docs.litellm.ai/docs/routing（LiteLLM 官方文档·路由/负载均衡页） | ✅ 成功，已读原文 |
| read_web_page | https://higress.ai/docs/latest/overview/what-is-higress/（Higress 官方文档·概览页） | ✅ 成功，已读原文 |
| read_web_page | https://github.com/songquanpeng/one-api（GitHub 主页） | ✅ 成功（本会话早期完成，原文在案） |
| read_web_page | https://github.com/QuantumNous/new-api（GitHub 主页） | ✅ 成功（本会话早期完成，原文在案） |
| web_search | one-api 渠道/令牌/额度/倍率/负载均衡相关检索 | ⚠️ 未返回可用结果列表（工具仅返回提示，无具体条目），该方向细节未能继续核实 |
| web_search | LiteLLM / Higress / one-api 等导航检索 | ⚠️ 部分调用未完成；仅获得导航级摘要（标题+URL+摘要），非页面证据 |

**结论性说明：** 本报告"已验证事实"仅指本次会话中实际读取到的页面原文内容；页面内容均为项目方自述，未做第三方交叉验证。凡本次未读到原文的细节（如 one-api 的倍率计费细节、New API 的额度机制等），一律归入"推断/观点"或"未能核实"，**不虚构**。

---

## 1. 执行摘要

四个代表性开源网关项目呈现出两种技术路线：

1. **应用层网关（one-api / New API / LiteLLM）**：以"渠道（Channel/Deployment）抽象 + 统一 API 适配 + Key/额度管理"为核心，直接面向"多上游聚合、二次分发、计量计费"场景，是当前国内中转站生态的主流形态。
2. **基础设施层网关（Higress）**：基于 Istio/Envoy 的云原生 AI 网关，以"协议统一、流量治理、可观测、Wasm 插件扩展"为核心，定位在 K8s 集群入口/微服务边界，可承载 AI 流量治理（负载均衡/fallback/token 流控/AI 缓存）。

已验证的关键事实（详见第 2 节）：LiteLLM 具备跨部署负载均衡、冷却/回退/超时/重试、Redis 用量跟踪（tpm/rpm）、usage-based-routing 等机制；Higress 具备统一协议对接多 LLM 厂商、多模型负载均衡/fallback、token 流控、AI 缓存、SSE 流式处理等能力；one-api 是"LLM API 管理 & 分发系统"且采用 channel/ability 分离的数据模型；New API 支持将多厂商模型交叉转换为 OpenAI/Claude/Gemini 兼容格式并支持多节点部署。

未能核实（重要）：one-api 与 New API 的**计费倍率、令牌额度、渠道优先级/故障切换**等具体机制，本次因检索未返回可用结果、且未读取其文档站/源码原文，**未能从原文验证**，仅能作为社区共识性推断列出。

---

## 2. 分项调研

### 2.1 one-api（songquanpeng/one-api）

**已验证事实（来源：https://github.com/songquanpeng/one-api 主页原文）：**

- 定位为"LLM API 管理 & 分发系统"，可用于 key 管理与二次分发，提供统一 API 适配。
- 支持的主流模型/厂商包括：OpenAI、Azure、Anthropic Claude、Google Gemini、DeepSeek、字节豆包、ChatGLM、文心一言、讯飞星火、通义千问、360 智脑、腾讯混元等。
- 交付形态：单可执行文件、提供 Docker 镜像、一键部署、开箱即用，提供英文 UI。
- 数据模型（主页 FAQ 原文）：存在 channel 表（渠道）与 ability 表（记录"某渠道支持某模型"）；若删除 channel 记录而未同步清理 ability 表，会触发"数据库一致性已被破坏"错误。→ 间接验证了其"渠道（上游供应商接入）与模型能力映射分离管理"的架构事实。

**推断/观点（本次未从原文验证，明确标注）：**

- 其"模型倍率计费 + 用户分组 + 令牌（Token）额度"机制是社区广泛描述的核心卖点，但本次未读取到 one-api 文档站/源码原文，**未能验证**。
- 其渠道级负载均衡（按权重/优先级分发）与失败渠道自动禁用/重试机制，同为社区常见描述，**未能验证**。
- 判断：one-api 是国内"中转站"生态的奠基性项目，其"渠道抽象 + 统一 OpenAI 兼容出口 + 令牌计量"模式被大量衍生项目沿用（New API 即其一，见 2.2）。

### 2.2 New API（QuantumNous/new-api）

**已验证事实（来源：https://github.com/QuantumNous/new-api 主页原文）：**

- 定位为"统一 AI 模型中心（unified AI model hub），用于聚合与分发（aggregation & distribution）"，是面向个人与企业模型管理的集中式网关。
- 核心能力：将各种 LLM 交叉转换为 OpenAI 兼容、Claude 兼容或 Gemini 兼容格式（cross-converting）。
- 多节点部署要求（主页原文）：所有节点必须使用同一主数据库和同一 SESSION_SECRET，否则 Access Token、刷新会话与临时认证流程无法一致校验；连接同一 Redis 的节点必须使用同一 CRYPTO_SECRET，否则缓存键摘要不一致。→ 验证了其支持多节点水平扩展、依赖共享数据库 + Redis 的部署形态。

**推断/观点（本次未从原文验证，明确标注）：**

- New API 被社区普遍认为是 one-api 的增强分支/衍生项目（新增 Claude/Gemini 兼容出口、更多计费与运营功能），此判断基于社区共识，**未在本次读取的页面原文中直接验证**。
- 其额度/计费/倍率细节与 one-api 同源，**未能验证**。

### 2.3 LiteLLM

**已验证事实（来源：https://docs.litellm.ai/docs/routing 官方文档原文）：**

- Router 核心职责：跨多个部署（如 Azure/OpenAI）负载均衡；对重要请求排队优先处理（Queueing），避免其失败；提供基础可靠性逻辑——冷却（cooldowns）、回退（fallbacks）、超时（timeouts）、重试（固定重试 + 指数退避）。
- 生产环境支持使用 Redis 跟踪冷却状态与用量（管理 tpm/rpm 限额）。
- 路由策略：支持 usage-based-routing（选择当前正在处理的并发调用最少的部署）；文档示例还展示了 least-busy 类策略的用法。
- 多部署配置模型：model_list 中 model_name 作为对外别名，可映射到多个部署；每个部署通过 litellm_params 指定实际 model、api_key、api_base、api_version（即"一个模型名 → 多个上游"的聚合模型）。
- 提供 LiteLLM Proxy Server，用于在服务端跨不同 LLM API 做负载均衡（文档明确建议：需要服务端负载均衡时使用 Proxy Server）。
- 多 provider 适配：示例覆盖 Azure、Bedrock、OpenAI 等（模型前缀如 azure/、bedrock/ 区分厂商）。

**推断/观点：**

- LiteLLM 的定位偏向"开发者/企业级模型路由 SDK + 代理"，其虚拟 Key、预算（budget）、支出追踪（spend tracking）、多租户等 Proxy 能力在本页未覆盖，**未能验证**（需读 Proxy 文档）。
- 判断：LiteLLM 的"别名→多部署"模型与 one-api 的"渠道"模型本质同构，都是"算力池接入层"的标准抽象。

### 2.4 Higress AI 网关

**已验证事实（来源：https://higress.ai/docs/latest/overview/what-is-higress/ 官方文档原文）：**

- 定位：CNCF Sandbox 开源 AI 原生 API 网关，基于 Istio 与 Envoy 构建；支持用 Go/Rust/JS 编写 Wasm 插件（沙箱隔离、可热更新）。
- 起源：阿里内部为解决 Tengine reload 对长连接业务有损、以及 gRPC/Dubbo 负载均衡能力不足而诞生；阿里云基于 Higress 构建云原生 API 网关产品，提供 99.99% 网关高可用保障。
- 生产背书：支撑通义千问 APP、百炼大模型 API、机器学习 PAI 平台等 AI 业务，服务零一万物、FastGPT 等。
- AI 网关能力（原文列举）：用统一协议对接国内外所有 LLM 模型厂商；多模型负载均衡/fallback；AI token 流控；AI 缓存；AI 可观测；支持真正的完全流式请求/响应 Body 处理与 SSE 自定义处理（降低大带宽场景内存开销）。
- 部署形态：可脱离 K8s，一行 Docker 命令启动；亦可作为 K8s Ingress 网关（兼容大量 Nginx Ingress 注解、支持 Gateway API 标准）。
- 安全/认证：WAF 能力，支持 key-auth、hmac-auth、jwt-auth、basic-auth、oidc 等多种认证鉴权。
- 其他：可作微服务网关（对接 Nacos、ZooKeeper、Consul、Eureka，深度集成 Dubbo、Sentinel）。

**推断/观点：**

- Higress 的"统一协议对接所有 LLM 厂商 + token 流控 + fallback + AI 缓存"组合，使其在"算力池接入层"场景中更偏**流量治理与安全边界**角色，而非业务级计费/额度系统；其计费/额度能力依赖插件生态，**本次未验证**是否有开箱即用的计量计费插件。
- 判断：Higress 与 one-api/LiteLLM 互补而非替代——前者管"流量怎么走"，后者管"谁能用、用多少、怎么算钱"。

### 2.5 横向对比（★=已验证；△=推断/未能核实）

| 维度 | one-api | New API | LiteLLM | Higress |
|---|---|---|---|---|
| 技术路线 | 应用层网关（Go 单二进制）★ | 应用层网关（one-api 衍生）★定位/△细节 | 应用层 SDK+Proxy（Python）★ | 基础设施层网关（Istio/Envoy+Wasm）★ |
| 多 provider 适配 | 统一 API 适配多家厂商 ★ | 交叉转换为 OpenAI/Claude/Gemini 兼容格式 ★ | model 前缀 + litellm_params 区分厂商 ★ | 统一协议对接所有 LLM 厂商 ★ |
| 负载均衡 | △渠道权重/优先级（未验证） | △同 one-api（未验证） | 跨部署负载均衡、usage-based-routing、least-busy ★ | 多模型负载均衡 ★ |
| 故障切换 | △失败渠道禁用/重试（未验证） | △同 one-api（未验证） | 冷却/回退/超时/重试（固定+指数退避）★ | fallback 能力 ★ |
| Key/额度/计费 | △令牌额度+倍率计费（未验证） | △同 one-api（未验证） | △虚拟 Key/预算/支出追踪（未验证，需读 Proxy 文档） | △依赖插件（未验证） |
| 限流 | △（未验证） | △（未验证） | tpm/rpm 限额 + Redis 用量跟踪 ★ | AI token 流控 ★ |
| 缓存 | △（未验证） | △（未验证） | △（未验证） | AI 缓存 ★ |
| 可观测 | △（未验证） | △（未验证） | △（未验证） | AI 可观测 ★ |
| 部署形态 | 单二进制/Docker 一键部署 ★ | 多节点 + 共享 DB + Redis ★ | SDK 或 Proxy Server ★ | Docker 单机或 K8s Ingress ★ |
| 典型定位 | 中转/二次分发站 | 中转/二次分发站（多协议出口） | 企业模型路由/网关 | 云原生 AI 流量治理 |

---

## 3. 作为"算力池"接入层的分析（推断为主，明确标注）

以下为基于第 2 节已验证事实的**推断/观点**，非已验证事实：

1. **统一抽象是接入层的前提（推断）**：one-api 的"渠道"、LiteLLM 的"model_name 别名→多部署"、Higress 的"统一协议对接所有厂商"，本质都是把异构上游（云厂商 API、自建 vLLM、第三方中转）抽象为一个 OpenAI 兼容出口。这使"算力池"对上层用户表现为"一个 API、一个 Key、一张账单"。
2. **计量与计费决定商业闭环（推断）**：中转网关的 Key/额度/倍率机制（one-api 系）与 tpm/rpm 用量跟踪（LiteLLM）是"算力池"对外售卖的基础；但 one-api/New API 的计费细节本次未能从原文验证，属于本分支最大证据缺口。
3. **流量治理能力决定池子质量（推断）**：Higress 的 fallback/token 流控/AI 缓存/流式处理，与 LiteLLM 的冷却/回退/重试，共同构成"算力池"的可靠性面——上游故障时自动切换、高峰时限流保护、重复请求命中缓存降本。
4. **两层网关可叠加（推断）**：典型一体化形态可能是"Higress（入口流量治理）→ one-api/LiteLLM（渠道聚合+计量计费）→ 自建 vLLM/K8s 算力池（分支二范围）"，即基础设施层网关与应用层网关串联。该形态的实测验证建议见第 6 节。

---

## 4. 关键数据与来源清单

**已读原文（已验证事实的来源）：**

| 来源 | URL | 用途 |
|---|---|---|
| one-api GitHub 主页 | https://github.com/songquanpeng/one-api | 定位、支持厂商、交付形态、channel/ability 数据模型 |
| New API GitHub 主页 | https://github.com/QuantumNous/new-api | 定位、协议交叉转换、多节点部署要求 |
| LiteLLM 官方文档·路由页 | https://docs.litellm.ai/docs/routing | 负载均衡、冷却/回退/重试、Redis 用量跟踪、路由策略、model_list 模型 |
| Higress 官方文档·概览页 | https://higress.ai/docs/latest/overview/what-is-higress/ | 项目定位、架构、AI 网关能力、部署形态、认证安全 |

**仅导航级检索结果（非页面证据，未作为事实引用）：**

- LiteLLM GitHub：https://github.com/BerriAI/litellm（摘要称"100+ LLM providers、OpenAI 格式统一接口"）
- Higress 官网：https://higress.cn/ 、https://higress.ai/en/（摘要称"CNCF Sandbox、基于 Istio 与 Envoy"）

---

## 5. 未能核实项与局限性（unverified）

如实列明，避免误导后续分支汇总：

1. **one-api 的计费/额度细节未能验证**：针对"one-api 渠道管理、令牌、额度、模型倍率、负载均衡"的 web_search 未返回可用结果列表；未读取 one-api 文档站与源码。倍率计费、分组、令牌额度、渠道优先级/故障切换等均属社区共识性推断。
2. **New API 的额度/计费细节未能验证**：未读取其文档站/源码；与 one-api 的差异（如 Claude/Gemini 兼容出口的转换细节）未验证。
3. **LiteLLM Proxy 的虚拟 Key/预算/支出追踪未验证**：本分支仅读到 routing 页，未读 proxy 文档。
4. **Higress 的计量计费插件能力未验证**：文档未在本次阅读范围内给出计费插件细节。
5. **无第三方交叉验证**：所有"已验证"均来自项目方自述页面，未与第三方评测/源码核对。
6. **商业与市场数据不在本分支范围**：定价、利润率、市场份额等属分支三，本报告未涉及。

---

## 6. 后续可深入方向

1. 读取 one-api / New API 文档站与源码（重点：channel/token/log 表结构、倍率与额度计算、渠道重试与禁用逻辑、模型价格配置）。
2. 读取 LiteLLM Proxy Server 文档（虚拟 Key、预算、支出追踪、多租户、与 Redis 的配合）。
3. 读取 Higress AI 网关插件文档（token 流控、fallback 配置、provider 协议转换、AI 缓存策略）。
4. 实测对比：Docker 一键部署 one-api / LiteLLM Proxy / Higress，构造多上游故障注入，验证负载均衡与故障切换行为。
5. 与分支二衔接：验证"网关 + vLLM/K8s GPU 算力池"一体化形态中，网关如何把自建推理服务注册为渠道/部署。