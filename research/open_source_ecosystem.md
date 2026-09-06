# 开源生态线调研：大模型中转/网关开源项目

> 调研对象：one-api、new-api、LiteLLM Gateway、Higress AI Gateway、ai-gateway（zuplo）
> 调研方法：web_search 检索 → read_web_page 实际读取 GitHub 仓库页与官方 README 验证
> 调研日期：2026-09-02
> 标注约定：✅ = 已验证事实（本次会话中实际读取到页面内容）；🔶 = 合理推断（基于已验证信息的推导）；❌ = 未能验证（页面读取失败，不做论断）

---

## 1. 项目概览与定位

### 1.1 one-api（songquanpeng/one-api）✅

**定位**：LLM API 管理 & 分发系统，支持 OpenAI、Azure、Anthropic Claude、Google Gemini、DeepSeek、字节豆包、ChatGLM、文心一言、讯飞星火、通义千问、360 智脑、腾讯混元等主流模型，统一 API 适配，用于 key 管理与二次分发。单可执行文件，提供 Docker 镜像。

**社区活跃度（✅，2026-09-02 读取 GitHub 页面）**：
- Star 36.7k / Fork 6.8k / 1,210 commits
- 语言：Go；仓库含 Dockerfile、docker-compose.yml、systemd service 文件（one-api.service）

**已验证功能特性**（来自 README）：
- 统一 OpenAI API 格式访问所有大模型，开箱即用
- 支持 30+ 供应商：OpenAI/Azure、Anthropic Claude（含 AWS Claude）、Google PaLM2/Gemini、Mistral、豆包（火山引擎）、文心一言、通义千问、讯飞星火、ChatGLM、360 智脑、腾讯混元、Moonshot AI、百川、MINIMAX、Groq、Ollama、零一万物、阶跃星辰、Coze、Cohere、DeepSeek、Cloudflare Workers AI、DeepL、together.ai、novita.ai、硅基流动 SiliconCloud、xAI
- 支持配置镜像及第三方代理服务
- 负载均衡方式访问多个渠道
- stream 流式传输（打字机效果）
- 多机部署（主从架构）
- 令牌管理：过期时间、额度、允许的 IP 范围、允许的模型访问
- 兑换码管理：批量生成/导出，用于账户充值
- 渠道管理（批量创建）、用户分组与渠道分组、按分组设置不同倍率
- 渠道自定义模型列表、额度明细、用户邀请奖励、美元额度显示
- 公告、充值链接、新用户初始额度
- 模型映射（重定向请求模型；注意：会重构请求体而非透传）
- 失败自动重试
- 绘图接口
- 支持 Cloudflare AI Gateway 作为渠道代理

**部署形态（✅）**：
- 单可执行文件（Go 编译）+ Docker 镜像（justsong/one-api 及 ghcr.io/songquanpeng/one-api；alpha 版另有镜像）
- docker-compose.yml、systemd（one-api.service）、宝塔面板部署教程
- 多机部署：所有服务器连接同一 MySQL 数据库（非 SQLite）；从服务器设 NODE_TYPE=slave；SYNC_FREQUENCY 定期同步配置；Redis（REDIS_CONN_STRING）减少数据库访问延迟

**合规约束（✅）**：README 明示「使用者必须遵循 OpenAI 使用条款及法律法规」；依据《生成式人工智能服务管理暂行办法》，不得对中国地区公众提供未经备案的生成式人工智能服务。

来源：https://github.com/songquanpeng/one-api

### 1.2 new-api（Calcium-Ion/new-api）✅（部分）

**定位（✅）**：README 自述为 "Next-Generation LLM Gateway and AI Asset Management System"（新一代 LLM 网关与 AI 资产管理平台），提供简体中文/繁体中文/English/Français/日本語 多语言文档。项目在开源社区中普遍被视为 one-api 的衍生/分支项目，面向中转站运营场景强化了计费、分销与资产管理能力。

**已验证配置项（✅，来自 README 环境变量表）**：
- AZURE_DEFAULT_API_VERSION（Azure API 版本，默认 2025-04-01-preview）
- ERROR_LOG_ENABLED（错误日志开关）
- PYROSCOPE_URL / PYROSCOPE_APP_NAME（接入 Pyroscope 性能分析）
- 另有请求体大小限制类配置（超限返回 413）

**未验证**：❌ GitHub star/commit/issue 数据（仓库页面读取失败：重定向被取消）。README 中关于「计费/倍率/兑换码」等具体功能细节在本次读取中被截断，未逐条验证。

来源：https://raw.githubusercontent.com/Calcium-Ion/new-api/main/README.md

### 1.3 LiteLLM Gateway（BerriAI/litellm）✅

**定位（✅）**：README 自述 "Open Source AI Gateway for 100+ LLMs. Self-hosted. Enterprise-ready. Call any LLM in OpenAI format."（开源 AI 网关，支持 100+ 大模型，可自托管、企业级就绪，以 OpenAI 格式调用任意 LLM）。提供 Python SDK 与 Proxy Server（AI 网关）两种形态，另有托管版（Hosted Proxy）与企业版（Enterprise Tier）。

**已验证功能特性**：
- 统一 OpenAI 格式调用 100+ 供应商：OpenAI、Anthropic、Gemini、Bedrock、Azure 等（✅ README 供应商矩阵）
- GitHub 页面描述（✅）："Rust core with Python SDK"，功能关键词包括 cost tracking（成本追踪）、guardrails（护栏/安全过滤）、load balancing（负载均衡）、logging（日志）；支持 Bedrock、Azure、OpenAI、Anthropic、VertexAI、vLLM、Nvidia NIM 等
- MCP Gateway（✅）：可将 MCP Server 接入网关，通过 /chat/completions 调用 MCP 工具（README 给出 curl 示例）

**部署形态（✅/🔶）**：自托管（self-hosted）已明确；Proxy 以 Docker 镜像分发、K8s 部署支持（Helm chart）属于合理推断，本次未直接读取到部署文档页面。

来源：https://raw.githubusercontent.com/BerriAI/litellm/main/README.md 、https://github.com/BerriAI/litellm

### 1.4 Higress AI Gateway（alibaba/higress）✅

**定位（✅）**：README 自述 "AI Gateway / AI Native API Gateway"（AI 原生 API 网关），并带有 CNCF Sandbox 徽章（✅ 已验证徽章存在，说明项目处于 CNCF 沙箱阶段）。

**已验证特性（✅）**：
- 深度集成 Dubbo、Nacos、Sentinel 等微服务技术栈
- 支持从 Nacos、ZooKeeper、Consul、Eureka 等服务注册中心发现微服务
- 具备安全网关能力（README 提及 security gateway 定位）

**部署形态（🔶）**：作为 CNCF 云原生项目且深度绑定微服务/服务注册中心生态，主要部署形态为 Kubernetes 原生（Ingress/网关形态）属合理推断；本次未直接读取到 K8s 部署文档，未验证具体安装方式。❌ star/commit 数据未获取（页面内容截断）。

来源：https://raw.githubusercontent.com/alibaba/higress/main/README.md

### 1.5 ai-gateway（zuplo/ai-gateway）❌

**状态**：GitHub 仓库页面读取失败（HTTP 404），web_search 亦未返回相关结果。无法确认该仓库当前状态（可能已改名、迁移或归档），**不做任何论断**。备注：任务描述中的「ai-gateway」也可能指其他同名项目，需进一步确认指代。

后续核实路径：GitHub 搜索 "zuplo ai-gateway"、访问 zuplo.com 官网文档，或改用 GitHub API（api.github.com/repos/zuplo/ai-gateway）。

---

## 2. 功能特性横向对比

| 维度 | one-api | new-api | LiteLLM | Higress |
|---|---|---|---|---|
| 协议转换（统一 OpenAI 格式） | ✅ 核心卖点 | ✅（推断同源） | ✅ 核心卖点 | 🔶 AI 网关能力，未逐项验证 |
| 路由/负载均衡 | ✅ 多渠道负载均衡 | 🔶 同源推断 | ✅ 页面关键词 load balancing | 🔶 网关路由为产品本职 |
| fallback/重试 | ✅ 失败自动重试 | 🔶 同源推断 | 🔶 未直接验证（推断具备） | 🔶 未直接验证 |
| 计费/额度/倍率 | ✅ 额度、分组倍率、兑换码、邀请奖励 | ✅ 定位为「AI 资产管理」，细节截断 | ✅ cost tracking（成本追踪） | ❌ 未涉及（网关定位） |
| 密钥管理 | ✅ 令牌管理（过期/IP/模型限制） | 🔶 同源推断 | ✅ guardrails；密钥管理细节未验证 | 🔶 安全网关能力 |
| 多机/集群部署 | ✅ 主从 + MySQL + Redis | 🔶 同源推断 | 🔶 推断支持 | ✅ CNCF 云原生定位 |
| 典型场景 | 中转站运营（key 二次分发） | 中转站运营 + 资产管理 | 企业统一 LLM 接入/治理 | 云原生基础设施层网关 |

---

## 3. 社区活跃度（已验证数据有限，注明来源）

| 项目 | Star | Fork | Commits | 验证状态 |
|---|---|---|---|---|
| one-api | 36.7k | 6.8k | 1,210 | ✅ 2026-09-02 GitHub 页面 |
| new-api | — | — | — | ❌ 页面读取失败 |
| LiteLLM | — | — | — | ❌ 未获取；但 README 持续更新、托管版/企业版并存，推断活跃度高（🔶） |
| Higress | — | — | — | ❌ 未获取；CNCF Sandbox 状态 ✅ |
| zuplo/ai-gateway | — | — | — | ❌ 404，状态不明 |

说明：commit/issue 趋势、维护频率（最近提交时间）等需要 GitHub API 或仓库页面二次验证，本次网络环境下未能全部完成。one-api 的 36.7k star 是中文 LLM 中转生态中规模最大的开源项目之一（相对判断，基于本次验证数据）。

---

## 4. 部署形态对比

| 项目 | 单机形态 | 容器化 | 多机/云原生 |
|---|---|---|---|
| one-api | ✅ 单 Go 可执行文件 + systemd | ✅ Docker 镜像（Docker Hub + GHCR）+ docker-compose | ✅ 主从多机（MySQL + Redis + SYNC_FREQUENCY） |
| new-api | 🔶 推断与 one-api 同源 | 🔶 推断提供 Docker 镜像 | 🔶 推断 |
| LiteLLM | ✅ Python 包/SDK | 🔶 推断 Docker 镜像 | 🔶 推断 K8s（Helm）；托管版存在 |
| Higress | — | — | 🔶 K8s 原生（CNCF Sandbox、服务注册中心集成） |

---

## 5. 关键结论

1. **两大流派并存**（✅ 基于已验证定位）：「one-api 系」（one-api、new-api 等衍生项目）面向**中转站运营**——key 二次分发、兑换码、分组倍率、令牌限制等开箱即用的商业化功能；「通用 AI 网关系」（LiteLLM、Higress）面向**企业统一接入与治理**——多供应商统一接口、成本追踪、护栏、云原生基础设施。
2. **one-api 系是「算力池/中转站」事实上的技术底座**（🔶 推断，但功能清单 ✅ 已验证）：兑换码充值、邀请奖励、分组倍率、多机部署直接支撑第三方中转站的商业模式；其 36.7k star 与 6.8k fork 规模（✅）佐证了生态影响力。
3. **LiteLLM 的差异化在企业级能力**（✅）：100+ 供应商、成本追踪、guardrails、MCP 网关、Rust core + Python SDK，定位比 one-api 系更「平台化」。
4. **Higress 代表「网关下沉到基础设施」的趋势**（✅/🔶）：CNCF Sandbox 项目，把 AI 网关能力内建到云原生 API 网关中。
5. **合规是中文生态的显性约束**（✅）：one-api README 明确要求遵守 OpenAI 条款与《生成式人工智能服务管理暂行办法》备案要求，说明中转站模式在中国面临明确的合规红线。

---

## 6. 未验证事项与后续步骤

- ❌ new-api 的 star/commit 数据与功能细节（README 被截断）
- ❌ zuplo/ai-gateway 仓库当前状态（404）
- ❌ LiteLLM、Higress 的 star 数与 issue/commit 趋势
- ❌ 各项目 K8s 部署文档、官方文档站细节
- 建议：网络环境恢复后重试 GitHub 页面读取，或改用 GitHub API（api.github.com/repos/{owner}/{repo}）获取 star/commit/issue 数据；LiteLLM 与 Higress 的官方文档站（docs.litellm.ai、higress.cn）可作为补充来源。