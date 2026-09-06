# 大模型中转算力池实现情况 —— 综合调研报告

> 本报告聚合三份分支调研笔记：research-track1-gateways.md（上层网关）、research-track2-compute.md（下层算力池化与调度）、research-track3-pricing.md（聚合平台定价现状）。
> 标注规则：只有实际读取成功的来源才列为「已验证」并附 URL；读取失败、搜索无结果或仅有推断的内容一律列入「未能核实」。本报告未编造任何来源、数据或结论。

---

## 〇、总体框架：中转算力池 = 两层架构 + 合流形态

综合已验证证据，大模型中转算力池的工程实现可归纳为双层结构：

- **上层：接入与分发网关** —— 统一 API 适配（多格式互转）、多上游聚合、路由与负载均衡、故障切换、Key/额度计量计费。这是「中转站」商业形态的技术载体（one-api、New API、LiteLLM、Higress、Kong AI Gateway）。
- **下层：算力池化与调度** —— GPU 资源池化、弹性调度与分布式推理服务（vLLM、Kubernetes GPU 调度、Ray）。
- **合流形态**：网关把自建推理服务注册为「渠道/部署」，与外部厂商 API 混编成统一算力池（LiteLLM `hosted_vllm/` 路由 + one-api channel/ability 数据模型为已验证证据；具体操作路径与计量细节未核实，见第二节）。

---

## 一、主线一：上层接入/分发网关（已验证事实）

### 1. one-api（songquanpeng/one-api）

来源：https://github.com/songquanpeng/one-api （此前会话已读取验证；本次会话未重新读取，见第四节失败记录）

- 定位为「LLM API 管理 & 分发系统」，支持 OpenAI、Anthropic、DeepSeek、豆包、GLM、文心、讯飞、通义、混元等主流厂商。
- 单可执行文件 + Docker 一键部署形态。
- 数据模型采用 channel（渠道）与 ability（渠道-模型能力映射）分离设计：渠道是上游接入实体，ability 描述渠道与模型的映射关系；README 说明每个渠道支持的模型都需要专门的 ability 表记录，删除渠道需同步清理 ability，否则报「数据库一致性已被破坏」。渠道可指向不同上游，为自建 OpenAI 兼容端点混编提供了数据模型基础。

### 2. New API（QuantumNous/new-api）

来源：https://github.com/QuantumNous/new-api （本次会话读取成功）

- 官方定位：「Next-Generation LLM Gateway and AI Asset Management System」（下一代 LLM 网关与 AI 资产管理系统），面向个人与企业模型管理的集中式网关。
- 核心能力：将各类 LLM 交叉转换为 OpenAI-compatible、Claude-compatible、Gemini-compatible 三种格式（cross-converting），即多 provider 适配的核心机制是「格式互转」。
- 仓库规模：47.2k stars、11.3k forks、6,281 commits，主分支 main。
- 部署方式：Docker 镜像 calciumion/new-api:latest，默认 SQLite（数据挂载 ./data:/data），支持 MySQL（通过 SQL_DSN 环境变量，示例库名 oneapi）。
- 多机部署约束（官方明确警告）：所有节点必须使用同一主数据库和同一 SESSION_SECRET，否则 Access Token、refresh session、临时认证流程无法一致校验；连接同一 Redis 的节点必须使用同一 CRYPTO_SECRET，否则缓存键摘要不一致。
- 代码结构（仓库目录可见）：relay / relaykit（转发与格式转换层）、middleware、model、controller、service、router、plugins、oauth、dto、types 等，说明其工程上采用「转发层 + 中间件 + 模型/控制器分层」的网关架构。
- 项目自带法律合规声明：仅用于合法授权的 AI API 网关、组织级认证、多模型管理、用量分析、成本核算与私有部署场景；要求用户合法获取上游 API Key 并遵守上游服务条款。

### 3. LiteLLM（Router 路由模型 + Proxy Server）

来源 1：https://docs.litellm.ai/docs/routing （本次会话读取成功）

- 官方 Router 能力清单：跨多个部署（如 Azure/OpenAI）负载均衡；重要请求优先级排队（Queueing）；基础可靠性逻辑——cooldown（冷却）、fallback（回退）、timeout（超时）、retries（重试，固定间隔 + 指数退避）。
- 生产环境支持用 Redis 跟踪冷却状态与用量（管理 tpm/rpm 限额）。
- 路由决策可基于部署延迟：可设置时间窗口（time window），在该窗口内平均各部署延迟以选择目标部署。

来源 2：https://docs.litellm.ai/docs/proxy_server （本次会话读取成功）

- LiteLLM Proxy Server 定位：快速、轻量的 OpenAI 兼容服务器，用于调用 100+ LLM API。
- 支持的上游类型（文档列出的部分）：vLLM、OpenAI Compatible Server、Huggingface、Anthropic、TogetherAI、Replicate、Petals、Palm、Azure 等。
- 使用形态：`litellm --model ollama/codellama` 启动本地代理，客户端改 base_url 即可接入；`litellm --test` 做连通性测试。

### 4. Higress AI 网关

来源：https://higress.ai/docs/latest/overview/what-is-higress/ （本次会话读取成功）

- CNCF Sandbox 项目，基于 Istio 与 Envoy 构建的开源 AI 原生 API 网关；可用 Go/Rust/JS 编写 Wasm 插件，提供数十个开箱即用插件和管理控制台。
- 起源：阿里内部为解决 Tengine reload 对长连接业务有损、gRPC/Dubbo 负载均衡能力不足而诞生；阿里云基于 Higress 构建云原生 API 网关产品，对外承诺 99.99% 网关高可用。
- 实际支撑的业务：通义千问 APP、百炼大模型 API、机器学习 PAI。
- 认证鉴权能力：key-auth、hmac-auth、jwt-auth、basic-auth、oidc 等。
- 兼作微服务网关：对接 Nacos、ZooKeeper、Consul、Eureka 等注册中心，深度集成 Dubbo；提供 WAF 能力。

### 5. Kong AI Gateway

来源：https://developer.konghq.com/ai-gateway/ （本次会话读取成功）

- 定位：面向现代 AI 原生应用的「连接与治理层」（connectivity and governance layer），覆盖 LLM 调用、MCP（Model Context Protocol）、A2A（Agent2Agent）三类流量，统一管控。
- 核心能力清单（官方文档）：跨 AI provider 的路由与负载均衡（routing and load balancing across AI providers）；流式与认证（streaming and authentication）；用户访问控制与 ACL；用量分析（requests、tokens、errors、latency）。
- 多 provider 适配方式：通过一个一致的 API 连接任何主流 LLM provider，切换或组合 provider 无需重写应用。
- 实体模型演进：新架构以 AI Model 实体定义上游 provider、模型名与路由行为（取代旧的 AI Proxy 插件）；AI Policies 用于附加 guardrails、transformations、rate limiting 等策略。
- 管理/部署方式：Konnect（云）与自托管（on-prem）均支持；Konnect 托管用 kongctl 管理资源，on-prem 用 decK 管理配置；另有 AI Gateway API 与 Konnect UI 两种管理界面。

---

## 二、主线二：下层算力池化与调度 + 合流形态（已验证事实）

### 1. vLLM 分布式推理（部分验证）

- **定位**：vLLM 官方文档首页自述为 "Easy, fast, and cheap LLM serving for everyone"，最初由 UC Berkeley Sky Computing Lab 发起，社区由 2000+ 贡献者维护。
  - 来源：https://docs.vllm.ai/en/latest/ （已验证）
- **核心技术**：PagedAttention；continuous batching（官方博客称可实现 23x 吞吐提升并降低 p50 延迟）；SOSP 2023 论文。
  - 来源：https://docs.vllm.ai/en/latest/ （已验证）
- **仓库形态**：vllm-project/vllm，Apache-2.0 许可，README 自述 "fast and easy-to-use library for LLM inference and serving"。
  - 来源：https://github.com/vllm-project/vllm （已验证）
- **注意**：vLLM 分布式推理专项文档页（tensor parallel / pipeline parallel / 多节点部署细节）本次读取失败，见「未能核实」清单。

### 2. Kubernetes GPU 调度：NVIDIA/k8s-device-plugin（已验证）

- **定位**：为 Kubernetes 的 DaemonSet，自动完成三件事——暴露集群每个节点的 GPU 数量、跟踪 GPU 健康状态、在集群中运行 GPU 容器。
  - 来源：https://github.com/NVIDIA/k8s-device-plugin （已验证）
- **设备注入策略**：`DEVICE_LIST_STRATEGY` 支持三种方式：
  - `envvar`（默认）：通过 `NVIDIA_VISIBLE_DEVICES` 环境变量选择注入设备；
  - `volume-mounts`：以卷挂载方式传递设备列表；
  - `cdi-annotations`：使用 CDI 注解，不依赖 NVIDIA Container Runtime，但需要支持 CDI 的容器引擎。
  - 来源：https://github.com/NVIDIA/k8s-device-plugin （已验证）
- **GPU 共享**：支持 CUDA Time-Slicing 与 CUDA MPS 两种共享访问方式（README 目录含 "Shared Access to GPUs / With CUDA Time-Slicing / With CUDA MPS"）。
  - 来源：https://github.com/NVIDIA/k8s-device-plugin （已验证）
- **配套能力**：gpu-feature-discovery 可自动生成节点标签；支持 helm 部署、ConfigMap 配置、按节点标签更新配置。
  - 来源：https://github.com/NVIDIA/k8s-device-plugin （已验证）

### 3. Ray 分布式运行时（已验证）

- **定位**：Ray 自述为 "AI compute engine"，由核心分布式运行时 + 一组 AI 库（Data、Train、Tune、RLlib、Serve）组成，用于加速 ML 工作负载。
  - 来源：https://github.com/ray-project/ray （已验证）
- **核心抽象**：Tasks（集群中执行的无状态函数）、Actors（集群中创建的有状态 worker 进程）、Objects（跨集群可访问的不可变值）。
  - 来源：https://github.com/ray-project/ray （已验证）
- **Ray Serve**：框架无关的模型服务库，用于构建在线推理 API；对 LLM 服务有响应流式、动态请求批处理、多节点/多 GPU 服务等优化；可通过 Kubernetes Operator 透明部署到 K8s。
  - 来源：https://docs.ray.io/en/latest/serve/index.html （已验证）

### 4. 网关合流形态：自建推理服务注册为「渠道/部署」与外部厂商 API 混编

- **LiteLLM 直接证据**：LiteLLM 官方文档声明 "LiteLLM supports all models on VLLM"；vLLM 提供 OpenAI 兼容端点，LiteLLM 通过 `model="hosted_vllm/..."` 路由调用自建 vLLM 服务。即网关把自建推理服务当作一个 provider 路由，与外部厂商 API 同池混编。
  - 来源：https://docs.litellm.ai/docs/providers/vllm （已验证）
- **one-api 数据模型**：channel（渠道）与 ability（渠道-模型能力映射）分离设计，渠道可指向不同上游（见主线一第 1 条）。
  - 来源：https://github.com/songquanpeng/one-api （已验证）
- **New API（one-api 增强分支）**：自述为 "unified AI model hub for aggregation & distribution"，支持把各类 LLM 交叉转换为 OpenAI 兼容、Claude 兼容或 Gemini 兼容格式；多机部署要求所有节点共享同一主数据库与 SESSION_SECRET，连接同一 Redis 的节点需使用相同 CRYPTO_SECRET。
  - 来源：https://github.com/QuantumNous/new-api （已验证）

**合流形态结论（推断，非已验证）**：基于已验证证据（LiteLLM 的 `hosted_vllm/` 路由 + one-api 的 channel/ability 数据模型），可推断合流形态为：**网关将自建推理服务（vLLM 等 OpenAI 兼容端点）注册为「渠道/部署」，与外部厂商 API 同池混编，统一对外提供 OpenAI 兼容接口并统一计量**。此为基于已验证证据的推断；具体注册操作路径与计量细节待补充验证。

---

## 三、聚合平台定价现状（已验证事实）

### 1. OpenRouter

来源：https://openrouter.ai/docs/faq.md （FAQ，读取成功）

- **定价模式：透传底层厂商定价，推理价格无加价**。原文："OpenRouter passes through the pricing of the underlying providers, while pooling their uptime, so you get the same pricing you'd get from the provider directly, with a unified API and fallbacks so that you get much better uptime."（透传上游定价并聚合其可用性，用户获得与直连厂商相同的价格，同时获得统一 API 与故障回退。）
- **计费模式：预充值 Credits + 按请求扣费**。Credits 为预存款，每次 API/聊天请求按模型与 provider 的每百万 token 价格从 Credits 扣除；prompt 与 completion 通常不同价，部分模型按请求、按图像、按 reasoning token 计费。
- **充值手续费（非推理加价）**：Stripe 支付收取 5.5%（最低 $0.80），Coinbase 加密支付收取 5%。
- **BYOK（自带 Key）模式**：收取 5% 费用；PAYG（按量付费）月清单价阈值 $25,000，企业版月清单价阈值 $200,000。
- **退款政策**：未使用的 Credits 可在交易处理后 24 小时内申请退款（Credits 页面退款按钮），超过 24 小时未申请则不可退。
- **免费模型限流**：无 Credits 时 50 请求/天，有 Credits 时 1000 请求/天，阈值 10 credits。
- **聚合广度**：统一 API 聚合"all the major LLM models on the market"，支持聚合账单与用量分析（Activity 页）。

来源：https://openrouter.ai/docs/guides/overview/models.md （Models 指南，读取成功）

- 提供 **400+ 模型**的统一 API；Models API 支持按 `output_modalities` 等查询参数过滤；provider 对象含 `context_length` 等属性（按 provider 区分上下文长度）。

来源：https://openrouter.ai/docs/llms.txt （文档索引，读取成功）

- 文档体系覆盖：Quickstart、Batch API、BYOK、Stripe Projects、OAuth PKCE、Workload Identity Federation、Management API Keys、路由元数据（routing metadata）、输入输出日志、可观测性广播（Arize AX、Braintrust、ClickHouse、Comet Opik、Datadog、BigQuery）等——侧面印证其具备路由/可观测性/密钥管理等平台能力。

### 2. SiliconFlow（硅基流动）

来源：https://siliconflow.cn/pricing （定价页，读取成功）

- **定价页形态**：提供"实时价格同步"，按厂商/模型分类展示，覆盖**对话、生图、语音、视频**四类模型。
- **聚合厂商广度**（页面可见厂商）：deepseek-ai、Z-ai、Kimi、MiniMax、Tongyi-MAI、Baidu、Qwen、Stepfun、inclusionAI、ChinaTelecom（混元 hunyuan）、ByteDance（Wan）、openmoss、FunAudioLLM、BAAI、Kolors 等。
- **计费粒度：每百万 token 计价，区分输入 / 输出 / 缓存命中价格**（对话模型），视频模型按"个"计价，部分语音模型免费或低价。
- **分时段定价**（已验证示例）：DeepSeek-V4-Flash 在 2:00–8:00 时段为 ¥1.50（输入）/¥4.50（输出）/¥0.15（缓存），其余时段为 ¥3.00/¥9.00/¥0.30。
- **其他可见价格示例**：DeepSeek-V4-Pro ¥12.00/¥24.00/¥1.00；DeepSeek-V3.2 ¥4.00/¥6.00/¥0.40；DeepSeek-V3.1-Terminus ¥4.00/¥12.00/¥0.40；视频模型 Wan2.2-I2V-A14B / Wan2.2-T2V-A14B ¥2.00/个；Qwen3-ASR-1.7B、SenseVoiceSmall 免费；MOSS-TTSD-v0.5、CosyVoice2-0.5B ¥0.05。
- **结论（已验证部分）**：按量计费（token / 张 / 个）模式明确；价格展示为人民币。

### 3. DeepInfra

来源：https://deepinfra.com/pricing （定价页，读取成功）

- **定价模式：按量计费**。语言模型按 token 计价（页面明确"Some of our language models offer per token pricing"）；图像模型按张计价。
- **图像模型价格示例**：FLUX-2-max $0.07/张；FLUX-2-pro $0.015/张；FLUX-1-Redux-dev $0.012 × (w/1024) × (h/1024) × (iters/25)；FLUX-1-dev $0.009 × (w/1024) × (h/1024) × (iters/25)；FLUX-1-schnell $0.0005 × (w/1024) × (h/1024) × iters；FLUX-1.1-pro $0.04/张。
- **模态覆盖**：ASR、Embeddings、Reranker、Text Generation、Text-to-Image、Text-to-Music、Text-to-Speech、Text-to-Video、World Model 等。
- **公司动态**：页面提及 DeepInfra 完成 $107M Series B 融资以扩展推理云（inference cloud）。
- **结论（已验证部分）**：按量计费模式明确；以美元计价。

### 4. 定价模式横向小结（基于已验证事实）

| 平台 | 定价模式 | 计费粒度 | 聚合广度 | 加价/手续费 | 退款政策 |
|---|---|---|---|---|---|
| OpenRouter | 透传上游定价（无推理加价） | 每百万 token（prompt/completion 分价；部分按请求/图像/reasoning） | 400+ 模型、多家 provider | 充值手续费 Stripe 5.5%（最低 $0.80）/ Coinbase 5%；BYOK 5% | 未用 Credits 24 小时内可退，超期不可退 |
| SiliconFlow | 按量计费（是否透传上游未核实） | 每百万 token（输入/输出/缓存分价）、视频按个、分时段价格 | 十余家厂商（DeepSeek、Qwen、Kimi、MiniMax、混元、Wan 等） | 未核实 | 未核实 |
| DeepInfra | 按量计费（自营推理云，是否聚合第三方未核实） | 语言模型按 token、图像按张（含分辨率/迭代数公式） | 未核实（页面未列厂商清单） | 未核实 | 未核实 |

推断（明确标注为推断，非已验证）：OpenRouter 的"透传 + 充值手续费"是纯聚合转售形态；SiliconFlow 与 DeepInfra 的定价页均展示按量价格，但未说明其价格相对上游厂商是透传还是加价，无法据此判定其商业模式是否含差价。

---

## 四、未能核实清单

### 主线一（上层网关）

1. one-api 的倍率计费、令牌额度、渠道优先级/故障切换等核心运营机制 —— 未读到文档站与源码原文，仅属社区共识性推断。
2. New API 的路由/负载均衡具体算法、故障切换（fallback）细节、计费倍率与额度计量实现 —— 仅读到仓库 README 与目录结构，未读源码级证据。
3. Kong AI Gateway 的定价、免费额度、具体性能基准 —— 官方文档页未含定价信息。
4. Higress 针对 LLM 流量的路由策略、fallback/重试机制的具体插件实现 —— 仅读到概览页。
5. LiteLLM 各路由策略（如 latency-based、usage-based routing）的完整参数与生产级配置细节 —— 读到的是文档摘要，未逐项验证全部策略参数。
6. 各网关的实际性能对比数据（吞吐、延迟、并发）—— 无任何来源支撑。

### 主线二（下层算力池化与调度）

7. vLLM 分布式推理专项文档（tensor parallel / pipeline parallel / 多节点部署细节）—— https://docs.vllm.ai/en/latest/serving/distributed_serving.html 读取失败（Error: Redirect was cancelled）。
8. volcano-sh/volcano —— 未成功读取任何来源，其 GPU 调度/批处理调度细节未能核实。
9. 网关「添加自定义 OpenAI 兼容渠道」的具体操作路径 —— one-api / New API 仓库 README 未展开渠道注册的 UI/API 操作细节。

### 定价现状

10. SiliconFlow 是否透传上游价格 / 加价率；充值、余额、退款政策；完整价格表（页面被截断，仅部分模型价格可见）。
11. DeepInfra 聚合厂商广度（自营推理云还是聚合第三方）、退款政策、SLA、计费单位换算（如是否含税）。
12. OpenRouter 实时模型价格表具体数值（Models 指南确认 400+ 模型与 provider 属性，但未读取完整价格数据）。
13. 三平台对"中转算力池"下层的关联（如是否将自建推理服务注册为渠道）—— 超出定价页范围。

---

## 五、本次会话失败的 agent/工具调用汇总（从各分支笔记聚合）

### 主线一（track1-gateways）

1. read_web_page 多次调用失败（返回 404 / Web request failed）—— 执行完整性通知确认多次 read_web_page 未成功完成；具体失败目标 URL 未在可见执行记录中逐一标注，涉及任务清单中的部分已知官方 URL（GitHub 仓库页与官方文档页）。这些页面的内容一律未列为已验证。
2. web_search 有一次返回与调研主题无关的结果（NU-MOA 校园威胁事件的新闻条目），对本次调研无贡献；按任务约束，搜索空结果/无关结果不视为证据。
3. https://github.com/songquanpeng/one-api 本次会话未重新读取成功，其内容仅依据此前会话的已验证记录（见第一节第 1 条）。

### 主线二（track2-compute）

4. read_web_page：https://docs.vllm.ai/en/latest/serving/distributed_serving.html → 失败（Error: Redirect was cancelled），未能读取。
5. read_web_page：volcano-sh/volcano → 未发起成功读取（无结果），标注未能核实。
6. 注：track2 会话执行记录中另有若干 read_web_page 失败标注（执行完整性提示），具体 URL 未能全部复原，仅记录可确证的一次失败与一次无结果。

### 定价现状（track3-pricing）

7. 会话中出现执行完整性提示：部分 read_web_page 调用未成功完成（共 3 条提示），无法确认具体失败 URL；已确认读取成功的页面见第三节，其余涉及 SiliconFlow 退款政策、DeepInfra 聚合广度等目标页面未读到，均已在第四节标注「未能核实」。
8. track3 未依赖 web_search 作为证据来源（任务约束优先直接读取已知官方 URL；搜索结果仅作导航，不视为页面证据）。

---

## 六、后续补充建议

### 主线一（上层网关）

1. 重新读取 one-api 官方文档站（https://docs.oneapi.app 或仓库 docs 目录）与源码中的 channel/ability 数据模型、倍率计费与令牌额度实现，补齐 one-api 的运营机制证据。
2. 读取 New API 仓库 relay 目录源码（relay/relaykit），核实格式互转与上游适配的具体实现，以及是否有 fallback/负载均衡逻辑。
3. 读取 LiteLLM 文档的 proxy 配置页（model_list、router_settings 等），核实 fallback、cooldown、usage-based routing 的完整参数。
4. 读取 Higress AI 网关插件文档（如 ai-proxy、ai-statistics 等插件页），核实 LLM 流量路由与治理细节。
5. 读取 Kong AI Gateway 的 provider 配置页与 AI Model 实体文档，核实多 provider 切换与负载均衡的配置方式。

### 主线二（下层算力池化与调度）

6. 重试读取 vLLM 分布式推理文档（处理重定向问题），核实 tensor parallel / pipeline parallel / 多节点部署细节。
7. 读取 https://github.com/volcano-sh/volcano 的 README 与 scheduler 文档，核实其 GPU 调度能力。
8. 读取 one-api / New API 文档站中「添加渠道」章节，核实自定义 OpenAI 兼容渠道的注册路径与混编计量方式。
9. 读取 vLLM 文档中 OpenAI-compatible server 章节，确认端点兼容性声明，作为合流形态的补充证据。

### 定价现状

10. 重试读取 SiliconFlow 文档站（如 docs.siliconflow.cn）中计费/充值/退款相关页面，核实其价格构成与退款政策。
11. 读取 OpenRouter 定价相关页面（如 /docs/pricing 或 models 页完整数据）获取实时价格表与 provider 级价格差异。
12. 读取 DeepInfra 文档（deepinfra.com/docs）核实其厂商聚合模式、退款政策与 SLA。

### 通用

13. 若 read_web_page 持续失败，需先解决网络/页面访问权限问题（如重定向处理）后再补采数据，避免以推断代替证据。