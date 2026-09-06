# 维度 3：融合层（API 中转网关 + 算力池一体化）调研笔记

> 调研日期：2026-09-03
> 说明：本文件为团队调研的维度 3 笔记。每条事实标注来源与验证状态；「已验证」指已通过 read_web_page 读取页面正文，「未核实」指仅有搜索摘要或读取失败。推断均明确标注。

---

## 1. 结论摘要

- 融合层的核心形态是「网关层 + 推理引擎层」两层解耦：网关负责统一路由、限流、Key 管理、负载均衡与容错，推理引擎（vLLM/SGLang）负责吞吐与显存效率，二者通过 OpenAI 兼容协议对接。
- 开源全栈代表组合：**LiteLLM（Proxy/Router）+ vLLM** 与 **Ray Serve LLM（网关+调度一体化）**。前者是"独立网关 + 独立引擎池"的松耦合；后者把路由、弹性伸缩、多实例协调做进同一框架，并支持 prefix-aware（前缀感知）路由提升 KV cache 命中。
- 商业产品代表：硅基流动（SiliconFlow）的「AI 算力运营服务（Token 工厂）」是典型的中转+算力池一体化商业形态，明确支持异构国产算力接入、秒级扩缩容、算力消纳/联合运营两种合作模式。
- 成本优化在开源层的两个抓手：**前缀感知路由（冷热路由的 cache 维度）** 与 **弹性伸缩/负载感知调度**；「抢占式实例」在本次调研的直接来源中未找到开源网关层的实现证据，商业平台侧未核实。

---

## 2. 已验证事实（含来源）

### 2.1 开源方案 A：LiteLLM Router / Proxy + vLLM

来源：https://docs.litellm.ai/docs/routing （已读取正文，2026-09-03）

- LiteLLM Router 提供：跨多个部署（如 Azure/OpenAI）的负载均衡；请求优先级管理；基础可靠性逻辑——冷却（cooldowns）、回退（fallbacks）、超时与重试（固定 + 指数退避）。
- 生产环境支持用 Redis 跟踪冷却状态与用量（管理 tpm/rpm 限额）。
- LiteLLM Proxy Server 可做多 LLM API 之间的负载均衡；支持按项目、API Key、模型设置预算与速率限制（该点同时见于 vLLM 官方文档的 LiteLLM 页面摘要）。

来源：https://docs.vllm.ai/en/stable/deployment/frameworks/litellm/ （页面读取失败，HTTP 429；**仅确认该官方集成文档页存在**，正文内容未核实）

- vLLM 官方文档设有专门的 LiteLLM 部署框架章节，说明「LiteLLM + vLLM」是官方认可的组合方式。

来源：AMD Cluster Documentation Hub（https://instinct.docs.amd.com/projects/cluster-documentation/latest/how-to/multi-node-inference-lb.html ，**仅搜索摘要，未核实**）

- 摘要显示：推理池（inference pool）由多个运行 vLLM 或 SGLang 的节点组成（tensor parallelism），LiteLLM 提供专门的路由与负载均衡——印证该组合在异构 GPU 集群中的典型用法。

### 2.2 开源方案 B：Ray Serve LLM（网关 + 调度一体化）

来源：https://docs.ray.io/en/latest/serve/llm/index.html （已读取正文）

- Ray Serve LLM 在 Ray Serve 原语之上专用于分布式 LLM 服务，暴露 OpenAI 兼容 API（chat/completions/embeddings）。
- 关键能力：多节点多模型部署、自动伸缩与负载均衡；张量/流水线/专家/数据并行；prefill-decode 分离（独立扩缩容 prefill 与 decode 阶段）；自定义请求路由（含 prefix-aware 路由）；多 LoRA 共享底座模型；引擎无关后端（vLLM、SGLang）。

来源：https://docs.ray.io/en/latest/serve/llm/architecture/overview.html （已读取正文）

- 核心组件 LLMServer：一个管理单个推理引擎实例的 Ray Serve Deployment，其 Replica 有三种协作模式——Isolated（独立处理请求，横向扩展）、Coordinated within deployment（数据并行注意力）、Coordinated across deployments（prefill-decode 分离）。
- 设计原则：引擎无关（通过 LLMEngine 协议支持 vLLM、SGLang 等）；可组合的服务模式；Builder 模式声明式构建部署图；基础设施逻辑（放置、伸缩）与应用逻辑（路由、处理）分离；协议化扩展点。

来源：https://docs.ray.io/en/latest/serve/llm/user-guides/prefix-aware-routing.html （已读取正文；页面标注该 API 为 alpha）

- PrefixCacheAffinityRouter 实现多级路由：先做负载均衡检查（比较各 replica 队列长度，差值低于 imbalanced_threshold 才进入前缀感知路由）；前缀匹配策略——匹配率 ≥10% 路由到历史前缀匹配率最高的 replica，<10% 路由到前缀缓存利用率最低的 replica，无前缀数据时用 Power of Two Choices；负载失衡时回退到 Power of Two Choices 优先保均衡。
- 路由维护分布式前缀树 actor（记录各 replica 处理过的输入前缀，支持自动淘汰，经 Ray detached actor 跨路由实例持久化）。
- 前提：vLLM 需开启 Automatic Prefix Caching（enable_prefix_caching=True），否则路由不生效。最佳实践：调节 imbalanced_threshold 与 match_rate_threshold、监控 cache hit 指标、从默认参数保守调优。

### 2.3 商业产品：硅基流动（SiliconFlow）「AI 算力运营服务 / Token 工厂」

来源：https://siliconflow.cn/token-factory （已读取正文，厂商官网页面）

- 定位：让任意算力资源快速转化为"Token 工厂"，即把算力池直接变成可计量的 AI 生产力。
- 多架构算力接入：支持英伟达、昇腾、沐曦、摩尔线程等国产算力，形成可规模化扩展的 Token 产能。
- 自研推理加速引擎：对推理过程深度优化，相同硬件条件下提升单位 GPU 的 Token 产出效率。
- 异构算力弹性调度：多品牌、多架构算力统一调度与动态分配，**秒级扩缩容**，提升 Token 产能利用率。
- 技术架构分层（官网图示）：终端 AI 应用（Agent/Coding/企业应用）→ AI 推理服务（API 服务 · 模型生态 · 服务治理）→ AI 算力运营层（推理引擎 · 异构调度 · 运维管理）→ 算力资源（英伟达 GPU · 国产算力 · 企业 GPU 集群）。
- 两种合作模式：① 联合运营——面向 IDC 运营商、区域智算中心、GPU 云服务商、国产芯片厂商，按实际服务量结算收益分成；② 算力消纳/算力服务化——面向自建 GPU 集群的政企/金融/运营商，把冗余算力对外提供 Token 服务。
- 模型生态：内置 100+ 模型。
- 客户评价（厂商自述，营销性内容，非独立第三方验证）：某区域智算中心 GPU 集群利用率"数倍提升"；某金融机构同硬件推理吞吐量"提升接近一倍"；某互联网企业将闲置算力对外服务化形成月收益。

### 2.4 行业对比文章（背景参照）

来源：https://segmentfault.com/a/1190000047983770 《企业级大模型网关选型实战：2026年六款API聚合平台怎么挑》（已读取正文）

- 2026 年 LLM Gateway 已成为企业 IT 基建常规环节；选型关注点：通道稳定性、协议跟进、财务合规走账、高并发能力。
- 对比对象：OpenRouter、硅基流动、星链 4SAPI、移动 MOMA、Vercel AI Gateway、腾讯云相关服务。
- OpenRouter：全球模型聚合早期玩家，开放动态模型市场，路由策略丰富，面向全球开发者/科研人群；短板是链路多层转接、稳定性依赖上游、支付税务为海外体系。
- 硅基流动：深耕国产开源大模型基础设施，自研推理引擎对 DeepSeek、Qwen 等做深度优化。

---

## 3. 推断（非直接验证，明确标注）

1. **LiteLLM + vLLM 组合的职责划分**（推断，依据 2.1 的文档事实）：LiteLLM 承担网关职责（路由、限流、预算、重试回退、Key 管理），vLLM 承担引擎职责（吞吐、前缀缓存、连续批处理），两者经 OpenAI 兼容协议对接；该组合是"独立网关 + 独立引擎池"的松耦合架构，适合已有 vLLM 集群、需要统一入口的场景。
2. **"冷热路由"在开源层的对应物**（推断）：本调研直接来源中未见"冷热模型路由"的统一定义；开源层最接近的机制是 Ray 的 prefix-aware 路由（对共享前缀的"热"请求做 cache 亲和调度）+ 弹性伸缩（把低负载 replica 缩掉）。"冷热"更多体现在 KV cache 命中维度，而非模型热度维度。
3. **抢占式实例调度**（未核实）：本次读取的文档均未提及网关层对抢占式/spot 实例的调度支持；商业平台（如 Together/Fireworks 的 spot GPU 定价）可能涉及，但本次未读取到页面证据，不能下结论。
4. **Ray Serve LLM 的定位**（推断，依据 2.2）：相比 LiteLLM 的"网关外挂"模式，Ray Serve LLM 是"网关-调度-引擎"一体化框架，把路由策略（prefix-aware）、弹性伸缩、多实例并行策略（prefill-decode 分离等）放进同一套原语，适合需要深度定制路由与多节点并行的大型部署。
5. **硅基流动 Token 工厂 = 融合层商业化的典型形态**（推断，依据 2.3）：其"算力运营层（推理引擎+异构调度+运维）→ API 服务 → 终端应用"的分层，实质就是把中转网关能力（API 服务、服务治理、模型生态）与算力池（异构 GPU、弹性调度）打包成一体化产品对外输出。

---

## 4. 未核实项与限制（明确列出）

- vLLM 官方 LiteLLM 部署文档页（docs.vllm.ai/en/stable/deployment/frameworks/litellm/）读取失败（HTTP 429），仅确认页面存在；LiteLLM 与 vLLM 的具体对接细节（如 retry/fallback 配置示例）未验证。
- AMD 集群文档页仅见搜索摘要，未读取正文。
- **商业玩家商业模式未核实**：Together AI、Fireworks、Groq、DeepInfra 的定价/算力池规模/spot 实例机制，仅获得搜索摘要（morphllm.com/comparisons/fireworks-vs-together、alignify.co/blog/inference-infrastructure、digitalocean.com 文章），均未读取正文。
- **llm-d（vLLM 生态的路由器）未核实**：搜索摘要显示其支持 prefix-aware 路由（读取 vLLM KV-cache 而非轮询）与 SLO-aware 自动伸缩，但未读取官方文档（docs.vllm.ai/en/latest/deployment/integrations/llm-d/）。
- 抢占式实例、冷热路由在商业产品中的具体实现：无直接来源，未验证。
- 硅基流动官网的客户评价为厂商自述，未做独立第三方核验。

---

## 5. 下一步（最小行动清单）

1. 重试读取 vLLM 官方 LiteLLM 集成页（docs.vllm.ai/en/stable/deployment/frameworks/litellm/），补齐对接细节。
2. 读取 llm-d 官方文档，核实其 prefix-aware 路由与 SLO 伸缩机制（对"冷热路由"维度很关键）。
3. 读取 morphllm 对比页与 alignify 推理平台列表页，补齐 Together/Fireworks/Groq/DeepInfra 的商业模式与算力池信息。
4. 如团队需要，补充搜索"抢占式实例 + LLM 推理"与"冷热路由 大模型"的中文资料，验证商业平台是否提供 spot/抢占式推理实例。