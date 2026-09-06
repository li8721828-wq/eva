# 海外主要玩家调研：大模型中转 / 算力池

> 调研日期：2026-09-03
> 方法：web_search + read_web_page 交叉验证，优先官网定价页与官方文档。本报告仅收录本次会话中实际读取成功的页面证据；未能读取到一手来源的玩家明确标注"未能核实"，不臆造数据。

---

## 一、核心结论摘要

1. **海外玩家分三类定位**：纯中转聚合（OpenRouter）、自有算力池 + 推理服务（Together AI、Fireworks AI、DeepInfra、Lambda、RunPod、Modal）、混合形态（Anyscale 等以平台/编排为主）。其中"中转聚合"与"自有算力池"并非互斥——Together/Fireworks 同时提供 Serverless 推理（按 token 计费）与裸 GPU 集群（按 GPU 小时计费），是典型的"混合"。
2. **定价模式高度趋同**：Serverless 推理普遍按每百万 token 计费（input/output 分开），并普遍对**缓存命中输入（cached input）打折**；裸算力按 GPU 小时/秒计费（Fireworks 按 GPU 秒，H100 约 $7–8/小时）。OpenRouter 作为纯中转，按 5.5% 平台费抽成而非加价卖 token。
3. **前缀缓存（KV cache 复用）已是标配**：Together AI 定价页明确列出 cached input 单价（如 DeepSeek V4 Pro 0813 缓存输入 $0.13 vs 常规输入 $1.32，约 10 倍价差）；Fireworks 在 Serverless Training API 中单列 cached prefill 价格。缓存定价的存在说明各家已把"前缀缓存"作为成本结构与定价的一部分。
4. **模型规模覆盖从 8B 小模型到 671B/2.4T 超大模型**：Together 在售模型含 Qwen3.8-2.4T-A95B（2.4T 参数 MoE）、Cogito v2.1 671B、DeepSeek V4 系列、GLM-5.x、Kimi K3、MiniMax M3 等；Fireworks 训练定价按参数量分档（≤16B / 16–80B / 80–300B / >300B），说明其平台已覆盖 DeepSeek V3、Kimi K2 级别的超大模型。
5. **价格战与推理成本下降的迹象明显**：Together 上 DeepSeek V4 Flash 0731 输入仅 $0.14/1M tokens、GLM-5.3-Flash $0.15/1M，小模型低至 $0.03；Fireworks 的 GPU 时价在 2026-09-01 起上调（H100 $7→$8、B200 $10→$13、GB300 $18→$20），显示裸算力供给端价格在回升，而 token 端价格仍在低位——两头挤压中转商的毛利空间。
6. **融资与算力规模**：DeepInfra 官网公告其完成 $107M Series B（本轮会话可核实）；其余玩家（Together、Fireworks、Anyscale、Lambda、Modal、RunPod）的融资与算力规模本轮未能从一手来源核实，见"未能核实"清单。

---

## 二、玩家逐一梳理

### 1. Together AI —— 混合（自有算力池 + Serverless + 集群出租）

**证据来源**：https://www.together.ai/pricing （2026-09-03 读取成功）

- **定位**：自有 GPU 算力池 + 推理平台。产品线横跨 Serverless Inference（按 token）、Provisioned Throughput、Dedicated Inference、GPU Clusters（按 GPU 出租，页面显示 On-demand B200s 已上线）、Fine-Tuning、Managed Storage、Model Shaping。
- **核心产品/API 形态**：OpenAI 兼容的 Serverless 推理 API；GPU 集群按需租用；微调服务（SFT/DPO，LoRA）。
- **支持的模型规模**：从 8B（Llama 3 8B Lite $0.14/1M、Qwen3.5 9B）到 671B（Cogito v2.1 671B $1.25/1M）再到 2.4T 参数 MoE（Qwen3.8-2.4T-A95B，输入 $2.00/1M）；另有 GLM-5.3、Kimi K3、MiniMax M3、DeepSeek V4 Pro/Flash、gpt-oss-120B 等。图像模型覆盖 FLUX 全系、GPT Image、Imagen、Seedream 等。
- **定价模式**：按 token（input/output 分列）+ 缓存输入折扣；微调按训练 token 计费（最低 $4.00/任务）；GPU 集群按资源计费。示例：DeepSeek V4 Pro 0813 输入 $1.32 / 缓存 $0.13 / 输出 $3.96；Kimi K3 输入 $3.00 / 缓存 $0.30 / 输出 $15.00；GLM-5.3-Flash 输入 $0.15 / 缓存 $0.03 / 输出 $0.50。
- **技术特色**：前缀缓存（cached input 定价可见）；FP8 量化吞吐档（Qwen3 235B "FP8 Throughput" 档位）；微调 + 推理一体化。
- **算力规模/融资**：未能核实（本轮无一手来源）。

### 2. Fireworks AI —— 混合（自有算力池 + Serverless + 按 GPU 秒出租）

**证据来源**：https://fireworks.ai/pricing （2026-09-03 读取成功）

- **定位**：自有算力池 + 推理/微调平台，主打"高吞吐、低延迟"的 Serverless 推理，并提供按 GPU 秒计费的 On-Demand Deployments。
- **核心产品/API 形态**：Serverless Inference（Standard / Priority / Fast 三档）；Managed Training（LoRA SFT/DPO、Full Param SFT/DPO）；Serverless Training API（共享常驻训练池，无预置成本）；On-Demand Deployments（按 GPU 秒）；Embeddings API。
- **支持的模型规模**：训练定价按参数量分档——≤16B（LoRA SFT $0.50/1M tokens）、16–80B（$3.00）、80–300B（$6.00，如 Qwen3-235B、gpt-oss-120B）、>300B（$10.00，如 DeepSeek V3、Kimi K2）。Serverless Training API 已支持 Qwen 3.8 27B、Kimi K3、DeepSeek V4 Flash、Muse Glimmer 30B。
- **定价模式**：Serverless 按 token（含 cached prefill 折扣）；训练按 1M 训练 token 或 GPU 小时；On-Demand 按 GPU 秒。GPU 时价（2026-09-01 起）：H100 $8.00、H200 $8.00、B200 $13.00、B300 $15.00、GB300 $20.00（8 月 31 日前分别为 $7/$7/$10/$12/$18；区域受限部署加价 1.5 倍）。Serverless Training API 示例：Qwen 3.8 27B prefill $1.86/1M、cached prefill $0.372、sample $5.595、train $4.103。
- **技术特色**：三档服务等级（Standard/Priority/Fast）；cached prefill 单独计价；Serverless 训练池（无空闲成本）；微调后模型按基础模型同价 serving。
- **算力规模/融资**：未能核实（本轮无一手来源）。

### 3. DeepInfra —— 自有算力池（推理云）

**证据来源**：https://deepinfra.com/pricing （2026-09-03 读取成功，页面内容部分截断）

- **定位**：机器学习推理基础设施（"Simple Pricing, Deep Infrastructure"），自有 GPU 池提供按 token 的语言模型推理与按张数的图像模型推理。
- **核心产品/API 形态**：Serverless 推理 API，覆盖 ASR、Embeddings、Reranker、Text Generation、文生图/文生视频/文生音乐、World Model 等；另有 DeepCluster（GPU 集群）产品线。
- **定价模式**：语言模型按 token；图像模型按张（如 FLUX-2-max $0.07/张、FLUX-1.1-pro $0.04/张、FLUX-2-pro $0.015/张，部分按分辨率/迭代数公式计价）。
- **技术特色**：按 token 的简单定价；多模态覆盖广。
- **融资**：官网公告完成 **$107M Series B**（用于扩展推理云）。算力规模数字未能核实。

### 4. OpenRouter —— 纯中转聚合（网关）

**证据来源**：https://openrouter.ai/pricing （2026-09-03 读取成功，页面内容部分截断）

- **定位**：纯中转/聚合网关，不自建算力池，路由到多家模型供应商（"25+ free models、4 free providers"）。
- **核心产品/API 形态**：统一 API 网关，一个 key 访问多供应商多模型；Auto-routing（自动路由）与 preferred vendor（首选供应商）选择；Chat 与 API 访问；Activity Logs & Export。
- **定价模式**：Free 计划（仅免费模型，50 reqs/day 限流）；Pay-as-you-go（**5.5% 平台费**，可享折扣）；Enterprise（SSO/SAML、合约 SLA、BYOK、管理 API key、数据策略路由等）。
- **技术特色**：自动路由 + 供应商策略路由；预算与消费控制；Prompt Caching 支持；模型/供应商策略管理。
- **算力规模/融资**：不适用（无自有算力）；融资未能核实。

---

## 三、未能核实清单（本轮无成功的一手来源）

以下玩家在本次会话中未能读取到官网/权威来源的有效内容（搜索无结果或页面读取失败），**以下描述仅为行业常识性背景，不代表已核实事实**，需后续补充：

- **Anyscale**：定位为 Ray 分布式计算公司 + Anyscale Endpoints 托管推理/微调服务。定位、定价、融资均**未能核实**。
- **Lambda Labs**：GPU 云（按 GPU 小时租用 + 1-Click Clusters 按需集群）。定价、算力规模、融资均**未能核实**。
- **Modal**：Serverless GPU 计算平台（函数级 GPU 调度、按秒计费、自动扩缩容、无冷启动）。定价与融资**未能核实**。
- **RunPod**：GPU Pod 按秒租用 + Serverless 推理（按 GPU 秒 + 请求计费）。定价与融资**未能核实**。
- **Together AI / Fireworks AI / Anyscale / Lambda / Modal / RunPod 的融资轮次与公开算力规模**：均**未能核实**。

**本轮证据缺口的原因**：多次 web_search 返回无结果；部分页面（如 openrouter.ai 子页面）返回 404。下一步最小动作：直接读取各公司官网定价页与官方博客（如 lambda.ai/pricing、modal.com/pricing、runpod.io/pricing、anyscale.com/platform、together.ai 官网新闻页），以及 TechCrunch/The Information 等媒体的融资报道。

---

## 四、主要玩家对比表

| 玩家 | 定位 | 核心产品/API 形态 | 模型规模覆盖 | 定价模式 | 技术特色 | 算力/融资（已核实部分） |
|---|---|---|---|---|---|---|
| Together AI | 混合（自有算力池 + 推理 + 集群出租） | Serverless 推理、Provisioned/Dedicated、GPU Clusters、Fine-Tuning | 8B → 671B → 2.4T MoE（Qwen3.8-2.4T、Cogito 671B、DeepSeek V4、GLM-5.x、Kimi K3） | 按 token（input/output/缓存输入分列）；微调按训练 token；集群按资源 | 前缀缓存定价、FP8 吞吐档、微调+推理一体 | 未能核实 |
| Fireworks AI | 混合（自有算力池 + Serverless + 按 GPU 秒出租） | Serverless Inference（三档 SLA）、Managed/Serverless Training、On-Demand Deployments、Embeddings | ≤16B 至 >300B（DeepSeek V3、Kimi K2 档） | 按 token（含 cached prefill）；训练按 token 或 GPU 小时；On-Demand 按 GPU 秒（H100 $8/h、B200 $13/h、GB300 $20/h，9 月起） | 三档服务等级、cached prefill 计价、Serverless 训练池 | 未能核实 |
| DeepInfra | 自有算力池（推理云） | Serverless 推理 API（文本/图像/音频/视频/Embedding/Reranker）、DeepCluster | 文本+多模态（FLUX 系列等） | 按 token；图像按张 | 简单统一定价、多模态覆盖 | **$107M Series B（官网公告）** |
| OpenRouter | 纯中转聚合 | 统一 API 网关、Auto-routing、多供应商路由 | 25+ 免费模型、数百模型（经第三方供应商） | 按 token + **5.5% 平台费**；Free/PAYG/Enterprise | 自动路由、供应商策略路由、预算控制、Prompt Caching | 无自有算力 |
| Anyscale | 混合/平台（Ray 生态） | 未能核实（预期：Endpoints 托管推理 + Ray 平台） | 未能核实 | 未能核实 | 未能核实 | 未能核实 |
| Lambda Labs | 自有算力池（GPU 云） | 未能核实（预期：GPU 按小时 + 1-Click Clusters） | 未能核实 | 未能核实 | 未能核实 | 未能核实 |
| Modal | 自有算力池（Serverless GPU） | 未能核实（预期：函数级 GPU 调度、按秒计费） | 未能核实 | 未能核实 | 未能核实 | 未能核实 |
| RunPod | 自有算力池（GPU Pod + Serverless） | 未能核实（预期：Pod 按秒 + Serverless 推理） | 未能核实 | 未能核实 | 未能核实 | 未能核实 |

---

## 五、关键数据与来源列表

| 数据点 | 数值 | 来源 |
|---|---|---|
| Together DeepSeek V4 Pro 0813 定价 | 输入 $1.32 / 缓存 $0.13 / 输出 $3.96（每 1M tokens） | together.ai/pricing |
| Together Qwen3.8-2.4T-A95B 定价 | 输入 $2.00 / 缓存 $0.25 / 输出 $6.00 | together.ai/pricing |
| Together 微调最低收费 | $4.00/任务；DeepSeek-V4 Flash LoRA SFT $6.00/1M tokens | together.ai/pricing |
| Together GPU Clusters | On-demand B200s 已上线 | together.ai/pricing |
| Fireworks GPU 时价（2026-09-01 起） | H100/H200 $8、B200 $13、B300 $15、GB300 $20（每小时；区域受限 1.5x） | fireworks.ai/pricing |
| Fireworks Serverless Training（Qwen 3.8 27B） | prefill $1.86 / cached $0.372 / sample $5.595 / train $4.103（每 1M） | fireworks.ai/pricing |
| Fireworks 训练分档 | >300B 模型 LoRA SFT $10.00/1M 训练 token | fireworks.ai/pricing |
| DeepInfra 融资 | $107M Series B（官网公告） | deepinfra.com/pricing |
| OpenRouter 平台费 | 5.5%（PAYG） | openrouter.ai/pricing |
| OpenRouter 免费层 | 25+ 免费模型、50 reqs/day | openrouter.ai/pricing |

---

## 六、后续可深挖方向

1. **补齐未能核实玩家**：读取 Lambda（lambda.ai/pricing）、Modal（modal.com/pricing）、RunPod（runpod.io/pricing）、Anyscale（anyscale.com）官网，核实其 GPU 定价、Serverless 计费与融资（Lambda 曾获巨额融资、Modal/RunPod 均有公开融资，需一手来源）。
2. **技术实现细节**：各家中转/推理层的开源组件——vLLM、SGLang、TGI 的使用情况；前缀缓存实现（如 Together 的缓存定价对应其 KV cache 复用策略）；OpenRouter 的路由算法（成本/延迟/质量多目标）。
3. **成本结构测算**：用 GPU 时价（H100 $8/h）与 token 定价反推毛利率——例如 8×H100 节点每小时产出 token 量 vs 该模型 token 收入，量化"两头挤压"程度。
4. **国内玩家对照**：硅基流动、无问芯穹、火山方舟、阿里百炼、百度千帆的定价与缓存策略，与本文海外数据做横向对比（价格水平、缓存折扣比例、GPU 时价）。
5. **趋势跟踪**：2024–2026 价格战时间线（DeepSeek 降价引发的连锁反应）、推理成本下降曲线、国产芯片（昇腾/寒武纪）接入对算力池成本的影响。