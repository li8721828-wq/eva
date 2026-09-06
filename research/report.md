# 大模型中转算力池调研报告（总报告）

> 调研日期：2026-09-03
> 方法：web_search + read_web_page 交叉验证，优先官网定价页与官方文档。
> 汇总自五份分报告：concepts.md（概念与技术）、overseas.md（海外玩家）、domestic.md（国内玩家）、business.md（商业模式）、trends.md（现状趋势）。
> **证据等级说明**：✅ = 本次会话已直接读取并核实的一手来源；⚠️ = 基于公开行业通识的归纳，未经本次检索交叉验证；❌ = 未能核实（web_search 多次返回零结果、官网读取失败）。**凡标注"未能核实"的内容均未做推测性填充。**

---

## 一、核心结论摘要

1. **"中转"与"算力池"正在合流为同一商业模式**：前台 OpenAI 兼容 API 网关（统一入口、多模型路由、统一计费）解决"入口与体验"，后台自研调度与推理引擎（异构 GPU 聚合、弹性供给、KV 缓存复用）解决"成本与供给"。二者结合即"中转算力池"：纯中转商毛利依赖差价、受上游价格战挤压；有自有算力池的混合型玩家毛利空间更大，是 2024–2026 的主流演进方向（推论，待验证）。

2. **海外玩家分三类定位，且"中转"与"算力池"并非互斥**：纯中转聚合（OpenRouter，透传上游定价、5.5% 平台费抽成）、自有算力池 + 推理服务（Together AI、Fireworks AI、DeepInfra）、混合形态（Together/Fireworks 同时提供按 token 的 Serverless 推理与按 GPU 小时/秒的裸算力出租）。✅

3. **定价模式高度趋同且已精细化**：Serverless 推理普遍按每百万 token 计费（input/output 分列）；缓存命中输入（cached input）普遍打折至常规输入价的约 10%（Together：DeepSeek V4 Pro 缓存 $0.13 vs 常规 $1.32；硅基流动：DeepSeek-V4-Flash 缓存 ¥0.15–0.30 vs 输入 ¥1.5–3.0）；裸算力按 GPU 小时/秒计费。前缀缓存（KV cache 复用）已是算力池成本结构与定价的标配。✅

4. **国内以硅基流动为"中转算力池"典型样本**：单一价格页聚合 DeepSeek、智谱、Kimi、Qwen、MiniMax、混元、字节 Seed、阶跃、面壁、美团 LongCat、BAAI 等 15+ 厂商、覆盖对话/生图/语音/视频全模态，同时提供共享池 / Pro 独占档 / 闲时半价（2–8 点）/ 缓存 10% 价 / 免费模型引流——"免费引流 → 共享池走量 → Pro 收溢价"的三层漏斗，与海外 Together/Fireworks 商业模式同构。✅

5. **价格战与推理成本下降对中转模式是"双刃剑"**：一方面毛利被压缩、纯差价型中转商加速出清；另一方面需求价格弹性放大、总 token 量高速增长，有自有算力池 + 推理引擎优化 + 缓存工程能力的玩家反而受益。行业洗牌方向是"从倒差价走向卖工程能力"（其中洗牌案例与降价时间线为 ⚠️ 推理，未经核实）。✅ 价格页证据 + ⚠️ 趋势判断

6. **推理引擎层面已具备完整技术栈**：vLLM 官方文档核实了 PagedAttention、continuous batching、chunked prefill、prefix caching、prefill/decode 分离、投机解码、FP8/INT4 量化、昇腾等硬件插件、200+ 模型架构支持——这些正是中转算力池实现"高吞吐、低单位成本"的工程基础。✅

7. **国产算力适配、OpenAI 兼容标准化、弹性算力供给是三条确定主线，但本次未能取得可核实证据**：vLLM 支持昇腾已核实（硬件插件层面），但国产卡在算力池中的实际占比、适配成熟度、成本对比均 ❌ 未能核实；OpenAI 兼容协议作为事实标准的普及率数据 ❌ 未能核实；闲时半价与 Pro 独占档说明"弹性算力供给"已产品化（✅），但边缘算力落地规模 ❌ 未能核实。

8. **本次调研的硬限制**：web_search 在本次会话中数十次调用全部返回空结果，仅靠 read_web_page 直接抓取成功获得 8 个一手页面（vLLM 文档、Together/Fireworks/OpenRouter/DeepInfra 定价页、硅基流动价格页、阿里云百炼、腾讯云 TI、Spheron 行业分析）。**火山方舟、百度千帆、无问芯穹、Anyscale、Lambda、Modal、RunPod、灰色商业中转站全部未能核实**，详见第六节。

---

## 二、分维度详细分析

### 2.1 概念界定

**API 中转/聚合服务**：以"统一 API 入口"为核心的中介层——对外暴露 OpenAI Chat Completions/Embeddings 兼容接口，一个 Key 访问多厂商多模型，按模型名/价格/延迟/可用性路由，统一计费配额，并提供日志、缓存、fallback 等增值能力。形态谱系从"纯中转（无自有算力）"到"自有算力 + 中转混合"再到"云厂商大模型平台"。（⚠️ 基于行业通识归纳）

**算力池化**：将异构 GPU（H100/A100/L40S/国产芯片）聚合成统一资源池，通过调度系统按需分配：异构资源混部、动态调度、弹性伸缩、断点续跑。（⚠️）

**交叉点**：中转层解决入口与体验，算力池解决成本与供给。二者结合形成"前台兼容网关 + 后台推理调度"的中转算力池模式。关键推论：纯中转毛利依赖差价（受上游价格战挤压），自有算力池 + 池化摊薄闲置成本，是主流演进方向。（⚠️ 推论）

### 2.2 技术实现要点

**已核实（vLLM 官方文档，docs.vllm.ai，2026-09-03）**：
- 吞吐优化：PagedAttention（KV cache 分页管理，消除显存碎片）、continuous batching、chunked prefill、prefix caching（相同 system prompt/对话前缀复用 KV cache，是降低首 token 延迟与算力成本的关键）。
- 执行优化：CUDA/HIP graph、torch.compile、FlashAttention/FlashInfer 内核、CUTLASS/TRTLLM 的 GEMM/MoE 内核。
- 量化：FP8、MXFP8/MXFP4、NVFP4、INT8/INT4、GPTQ/AWQ/GGUF。
- 解码加速：投机解码（n-gram、suffix、EAGLE、DFlash）。
- 架构：prefill/decode 分离部署、tensor/pipeline/data/expert/context 并行、多 LoRA、结构化输出、OpenAI 兼容 API + Anthropic Messages API + gRPC。
- 硬件：NVIDIA/AMD GPU、CPU、Google TPU、Intel Gaudi、IBM Spyre、**华为昇腾 Ascend**、Apple Silicon 等插件；200+ 模型架构。

**待验证（⚠️，无本次会话来源）**：请求路由与负载均衡（L4/L7 结合、健康检查、慢实例剔除）；多模型动态调度（模型换入换出、优先级队列、抢占）；异构算力统一调度（Kubernetes + 设备插件底座）；弹性伸缩（QPS/队列深度/GPU 利用率驱动，优雅排空）；断点续跑（checkpoint 持久化 + 幂等重试）；计费配额与限流降级（令牌桶、429 背压、fallback 链）；SGLang 的 RadixAttention 前缀树缓存（与 vLLM 并称主流开源引擎，需读 docs.sglang.ai 核实）。

### 2.3 市场格局

**海外（✅ 已核实 4 家，❌ 未核实 4 家）**：
- **Together AI**（混合）：自有 GPU 算力池 + Serverless 推理（按 token）+ GPU 集群出租 + 微调。模型覆盖 8B 到 2.4T 参数 MoE（Qwen3.8-2.4T-A95B 输入 $2.00/1M）。定价页明确列出缓存输入折扣（DeepSeek V4 Pro 0813：输入 $1.32 / 缓存 $0.13 / 输出 $3.96；Kimi K3：$3.00/$0.30/$15.00；GLM-5.3-Flash：$0.15/$0.03/$0.50）。微调最低 $4.00/任务；Batch API 折扣约 20–33%。
- **Fireworks AI**（混合）：Serverless 推理（Standard/Priority/Fast 三档）+ 按 GPU 秒出租 + Serverless Training API。GPU 时价 2026-09-01 起上调：H100/H200 $8、B200 $13、B300 $15、GB300 $20/小时（8 月 31 日前 $7/$7/$10/$12/$18，区域受限 1.5x）——裸算力供给端价格回升而 token 端价格低位，两头挤压中转毛利。训练按参数量分档：≤16B $0.50、16–80B $3.00、80–300B $6.00、>300B $10.00（每 1M 训练 token）。
- **DeepInfra**（自有推理云）：官网公告 $107M Series B；按 token 语言模型 + 按张图像模型；据 Spheron 2026 行业分析，采用 Flex 0.8x / Standard 1x / Priority 1.5x 三级费率，token 单价跨度约 140 倍（Llama 3.1 8B $0.02 → Kimi-K3 $2.85/百万输入 token），另售 GPU 小时租赁（A100 ≈ $0.89/hr → B300 ≈ $4.89/hr）。
- **OpenRouter**（纯中转）：官网 FAQ 确认"透传（passes through）底层提供商定价"不额外加价；PAYG 按 5.5% 平台费抽成；免费层 25+ 免费模型、50 reqs/day；盈利依赖信用额度资金沉淀、订阅与增值服务（BYOK、Batch API、MCP、日志集成）。
- ❌ Anyscale、Lambda、Modal、RunPod：官网本轮读取失败，定位/定价/融资均未核实。

**国内（✅ 已核实 3 家，❌ 未核实 4 类）**：
- **硅基流动 SiliconFlow**（混合，最典型）：聚合 15+ 厂商 60+ 模型（DeepSeek-V4 系、GLM-5.x、Kimi-K2.7、Qwen3.6/3.5、MiniMax、混元、Seed、Step、面壁、LongCat、BAAI bge、Wan 视频、Kolors 生图等），自研推理引擎 + 预留实例 + 私有化部署；官网宣称延迟降 70%、吞吐 3–5 倍（厂商自述，非独立测试）。定价：按 token 输入/输出/缓存三档 + 分时（DeepSeek-V4-Flash 闲时 2–8 点半价：输入 ¥1.5 vs ¥3.0、输出 ¥4.5 vs ¥9.0）+ Pro 独占档 + 免费模型引流 + 预留实例（价格未披露）。
- **阿里云百炼**（云厂商聚合平台）：Qwen 系为核心（Qwen3.8-Max、Qwen3.8-Flash 百万上下文）+ 万相 Wan3.0 视频；Token Plan 订阅（包月 39 元起）+ 按量后付费；企业级多模态 RAG。
- **腾讯云 TI**（AI 开发平台 PaaS）：TI-ONE/TI-Matrix/TI-OCR，平台免费体验、按关联云资源（如 COS）计费；TI-ACC 自研加速、分布式训练、三种部署形态。不主打模型中转，更接近"算力 + 工具链"。
- ❌ 火山引擎方舟（页面无可读文本）、百度千帆（重定向拦截）、无问芯穹 Infini-AI（读取失败）、灰色商业中转站（多次检索零结果）——定位、生态、定价、合规风险均未核实。

### 2.4 商业模式与成本结构

**模式分类**（✅ 模式定义有来源，❌ 量化数据未核实）：
1. **纯中转/差价聚合**（OpenRouter）：轻资产、无 GPU 采购成本；透传定价承诺约束加价空间，毛利来自服务费/订阅/资金沉淀而非 token 差价。✅
2. **自有算力池 + 按量计费**（Together/DeepInfra/Fireworks/硅基流动）：重资产；毛利 = token 售价 −（GPU 成本 + 推理优化 + 运维）；通过引擎优化与缓存降低单位成本放大毛利。✅
3. **订阅制**：存在"按量 + 套餐"混合计费，具体档位 ❌ 未核实。
4. **算力分成/GPU 算力市场**（DeepInfra 售 GPU 小时、Modal/RunPod 容器化算力市场）：毛利 = GPU 小时价 − 折旧/电力/机房，与 token 计价解耦。✅（DeepInfra 部分）
5. **企业级定制/私有化**：合规驱动（数据不出域），毛利通常高于标准 API，报价 ❌ 未公开。
6. **混合模式（主流趋势）**：既吃自有算力 token 差价，又吃第三方模型聚合流量，叠加 Batch、微调、专用实例等高毛利服务。

**成本结构**（✅ 已验证数据 + ⚠️ 明确标注的推断）：
- GPU 成本是最大头：已验证 A100 ≈ $0.89/hr、B300 ≈ $4.89/hr（Spheron）；推断 GPU 成本占推理总成本 60–80%。
- 引擎优化决定盈亏平衡：推断同一张 H100 上优化良好的引擎吞吐可提升数倍，直接压低单位 token 成本——这是"不同厂商 token 单价可差数倍"的根本原因（佐证：DeepInfra 平台 token 价跨度约 140 倍）。
- 缓存命中是结构性成本优势：缓存定价 ≈ 输入价 10%（已验证），命中时跳过 prefill、边际成本接近纯解码；聚合网关因多租户共享前缀（system prompt、few-shot 模板）天然有更高缓存命中率，是**中转/聚合模式相对单租户自建的结构性成本优势**（⚠️ 推断）。
- 毛利率排序（⚠️ 推断）：企业定制/私有化 > 高单价大模型 API > 低价小模型 API（可能为负）> GPU 小时租赁（接近硬件成本加成）。以 A100 $0.89/hr 反推：若单卡吞吐 1,000–3,000 tokens/s（推断值），对应 Llama 8B 级 $0.02–0.05/1M 售价，单卡小时收入约 $0.07–0.5，**低价档模型在裸 GPU 成本上即可能亏损**——这解释了为何低价模型必须靠批量、缓存与高利用率摊薄成本，也解释了为何厂商倾向主推高单价大模型。

### 2.5 现状与趋势（2024–2026）

**已验证（✅ 硅基流动价格页，2026-09-03）**：
- 主流模型输入价已进入"每百万 token 人民币 0.4–12 元"区间，大量免费模型存在；"低价 + 动态定价"已是常态而非促销。
- 缓存定价（≈10% 输入价）与闲时半价的存在，说明平台已将"算力利用率"与"缓存命中率"显性化为价格机制——成本下降的工程来源而非单纯补贴。
- 同一模型存在"厂商直连价"与"平台价"并存（如 DeepSeek-V3.2 与 V3.2(Pro) 同价），说明平台在部分模型上以平价甚至补贴换取流量。
- 2026 年模型代际已推进至 DeepSeek-V4、GLM-5.x、Kimi-K2.7、Qwen3.6（价格页实证）。

**未能核实（❌，一般性推理，不得作为事实引用）**：
- 2024 年 5 月 DeepSeek-V2 引发第一轮降价潮、2025 年初 R1 发布后各厂商跟进降价、部分模型一年降价 90% 以上的时间线与幅度——需官方公告/权威媒体补证。
- 推理成本逐年下降的量化曲线（SemiAnalysis/IDC 类机构口径）。
- 昇腾/寒武纪在主流推理栈的适配成熟度、国产卡在算力池中的实际占比与成本对比。
- OpenAI 兼容协议普及率、各平台兼容度差异数据。
- 国内中转站洗牌案例、OpenRouter/Together 等海外平台流量与收入数据。

**趋势判断（⚠️ 推理，方向性）**：
- 降价传导路径：模型厂商降价 → 中转平台同步调价 → 差价空间收窄 → 中转商转向算力运营与增值服务。价格战压缩的是"信息差利润"而非"工程利润"。
- 推理成本下降由四条曲线叠加：硬件代际、推理引擎优化、模型架构（MoE 稀疏激活、MLA 类 KV 压缩）、缓存与调度。中转算力池是后三者的集成者，单位成本下降通常快于单厂商直连。
- 中转算力池演进三阶段：① 纯 API 聚合（倒差价、门槛低、同质化）→ ② 自建算力池 + 推理优化（缓存、批处理、调度，形成成本壁垒）→ ③ 算力市场/弹性供给（按需租用、闲时竞价、边缘节点）。2024–2026 正处于 ①→② 的洗牌期。
- 弹性算力供给四维度：时间（闲时折扣，已验证）、资源（共享池 vs 独占，已验证）、空间（多地域就近调度）、所有权（自有 + 租用 + 市场竞价混合）。终局形态可能是"算力交易所"：以 API 为界面、以价格信号为调度器、以缓存和批处理为效率杠杆。
- OpenAI 兼容标准化是"中转"模式的技术前提（切换成本降到"换 base_url + api_key"），放大网络效应的同时加速功能同质化与价格战。

---

## 三、主要玩家对比表

| 维度 | Together AI（海外） | Fireworks AI（海外） | DeepInfra（海外） | OpenRouter（海外） | 硅基流动（国内） | 阿里云百炼（国内） | 腾讯云 TI（国内） | 方舟/千帆/无问芯穹/中转站 |
|---|---|---|---|---|---|---|---|---|
| **定位** | 混合：算力池 + Serverless + 集群出租 | 混合：算力池 + Serverless + 按 GPU 秒 | 自有推理云 | 纯中转聚合网关 | 混合：聚合 + 自研推理 + 预留实例 | 云厂商聚合平台 | AI 开发平台（PaaS） | ❌ 未能核实 |
| **模型生态** | 8B→2.4T MoE（Qwen3.8-2.4T、Cogito 671B、DeepSeek V4、GLM-5.x、Kimi K3、MiniMax M3、FLUX 等） | 训练分档至 >300B（DeepSeek V3、Kimi K2）；Serverless 训练池支持 Qwen3.8 27B 等 | 语言 + 图像 + 音视频 + World Model，覆盖广 | 全市场模型聚合、25+ 免费模型 | 15+ 厂商 60+ 模型（对话/生图/语音/视频/向量） | Qwen 系 + 万相 Wan3.0 + 图片/视觉 | 不主打模型清单，重平台工具链 | ❌ |
| **定价模式** | 按 token（输入/输出/缓存三档）+ Batch 折扣 20–33% + 微调按 token + GPU 集群 | Serverless 按 token（含 cached prefill）+ 训练分档 + 按 GPU 秒 | 按 token / 按张；Flex/Standard/Priority 三级费率；GPU 小时租赁 | 透传上游价 + 5.5% 平台费 | 按 token 三档 + 分时半价 + Pro 档 + 免费模型 + 预留实例 | Token Plan 订阅（39 元/月起）+ 按量 | 平台免费，按关联云资源计费 | ❌ |
| **缓存定价** | 缓存 ≈ 输入价 10%（$0.13 vs $1.32） | cached prefill 单独计价（$0.372 vs $1.86） | 未在可读页面见缓存价 | —（透传） | 缓存 ≈ 输入价 10%（¥0.15–0.30） | 未披露 | 未披露 | ❌ |
| **技术特色** | 前缀缓存、FP8 吞吐档、微调+推理一体化 | 三档服务等级、Serverless 训练池（无空闲成本） | 简单定价、多模态覆盖 | 自动路由 + 首选供应商、可用性聚合 | 自研推理引擎（宣称延迟降 70%、吞吐 3–5x）、昇腾国产化部署 | 百万上下文、多模态 RAG、CLI 订阅 | TI-ACC 加速、分布式训练、三种部署形态 | ❌ |
| **融资/规模** | ❌ 未核实 | ❌ 未核实 | ✅ $107M Series B（官网） | ❌ 未披露 | ❌ 未披露 | —（云厂商） | —（云厂商） | ❌ |
| **证据状态** | ✅ together.ai/pricing | ✅ fireworks.ai/pricing | ✅ deepinfra.com/pricing + Spheron | ✅ openrouter.ai | ✅ siliconflow.cn/pricing | ✅ aliyun.com/product/bailian | ✅ cloud.tencent.com/product/ti | ❌ 全部未核实 |

---

## 四、关键数据与来源列表

| # | 数据/事实 | 数值 | 来源（本次会话已读取） | 证据等级 |
|---|---|---|---|---|
| 1 | vLLM 推理能力清单（PagedAttention、continuous batching、chunked prefill、prefix caching、PD 分离、投机解码、量化、昇腾插件、200+ 架构） | — | docs.vllm.ai（2026-09-03） | ✅ |
| 2 | Together DeepSeek V4 Pro 0813 定价（/1M tokens） | 输入 $1.32 / 缓存 $0.13 / 输出 $3.96 | together.ai/pricing | ✅ |
| 3 | Together Qwen3.8-2.4T-A95B 定价 | 输入 $2.00 / 缓存 $0.25 / 输出 $6.00 | together.ai/pricing | ✅ |
| 4 | Together GLM-5.3-Flash / Kimi K3 定价 | $0.15/$0.03/$0.50；$3.00/$0.30/$15.00 | together.ai/pricing | ✅ |
| 5 | Together 微调最低收费 | $4.00/任务；DeepSeek-V4 Flash LoRA SFT $6.00/1M | together.ai/pricing | ✅ |
| 6 | Fireworks GPU 时价（2026-09-01 起） | H100/H200 $8、B200 $13、B300 $15、GB300 $20/小时（此前 $7/$7/$10/$12/$18；区域受限 1.5x） | fireworks.ai/pricing | ✅ |
| 7 | Fireworks Serverless Training（Qwen 3.8 27B） | prefill $1.86 / cached $0.372 / sample $5.595 / train $4.103（每 1M） | fireworks.ai/pricing | ✅ |
| 8 | Fireworks 训练分档 | ≤16B $0.50 / 16–80B $3.00 / 80–300B $6.00 / >300B $10.00（每 1M 训练 token） | fireworks.ai/pricing | ✅ |
| 9 | DeepInfra 融资 | $107M Series B（官网公告） | deepinfra.com/pricing | ✅ |
| 10 | DeepInfra 费率分级与 token 价跨度 | Flex 0.8x / Standard 1x / Priority 1.5x；$0.02（Llama 3.1 8B）→ $2.85（Kimi-K3）/1M 输入，跨度约 140x | spheron.network/blog/deepinfra-pricing-2026 | ✅（二手行业分析） |
| 11 | DeepInfra GPU 小时租赁 | A100 ≈ $0.89 → B300 ≈ $4.89/小时 | 同上（Spheron） | ✅（二手） |
| 12 | OpenRouter 平台费与免费层 | PAYG 5.5% 抽成；25+ 免费模型、50 reqs/day；透传上游定价 | openrouter.ai/pricing + openrouter.ai/docs/faq | ✅ |
| 13 | 硅基流动 DeepSeek-V4-Flash 定价（¥/1M） | 输入 ¥1.5（闲时 2–8 点）/¥3.0；输出 ¥4.5/¥9.0；缓存 ¥0.15/¥0.30 | siliconflow.cn/pricing | ✅ |
| 14 | 硅基流动 DeepSeek-V4-Pro / V3.2 / GLM-5.2 | ¥12/¥24/¥1.0；¥4/¥6/¥0.4；¥8/¥28/¥2.0 | siliconflow.cn/pricing | ✅ |
| 15 | 硅基流动模型生态 | 15+ 厂商、对话/生图/语音/视频全模态；免费模型（GLM-Z1-9B、Hunyuan-MT-7B、bge、星辰 ASR、Kolors） | siliconflow.cn/pricing | ✅ |
| 16 | 阿里云百炼 Token Plan | 包月 39 元起；Qwen3.8-Max/Flash、万相 Wan3.0 | aliyun.com/product/bailian | ✅ |
| 17 | 腾讯云 TI 计费模式 | 平台免费体验，按关联云资源计费；TI-ACC 加速 | cloud.tencent.com/product/ti | ✅ |
| 18 | 硅基流动性能宣称 | 延迟降 70%、吞吐 3–5x（厂商自述，非独立测试） | siliconflow.cn 首页 | ✅（厂商自述） |
| 19 | 2024–2025 降价潮时间线与幅度（如"年降 90%"） | — | 无来源 | ❌ 未能核实 |
| 20 | 推理成本逐年下降量化曲线 | — | 无来源 | ❌ 未能核实 |
| 21 | 昇腾/寒武纪适配成熟度与国产卡占比 | — | 无来源 | ❌ 未能核实 |
| 22 | 火山方舟/百度千帆/无问芯穹/Anyscale/Lambda/Modal/RunPod 定位与定价 | — | 读取失败/零结果 | ❌ 未能核实 |

---

## 五、后续可深挖方向

1. **补齐未能核实玩家**：读取 lambda.ai/pricing、modal.com/pricing、runpod.io/pricing、anyscale.com，以及火山方舟（volcengine.com/product/ark）、百度千帆（cloud.baidu.com/product/wenxinworkshop）、无问芯穹（infini-ai.com）官网（需修复重定向/直连），核实定位、定价与融资。
2. **成本结构测算**：用 GPU 时价（H100 $8/h、A100 $0.89/h）与 token 定价反推毛利率——8×H100 节点每小时产出 token 量 vs 该模型 token 收入，量化"两头挤压"程度；对比硅基流动"平台价 vs 厂商直连价"的差价与补贴幅度。
3. **缓存经济学**：缓存 10% 定价背后的成本假设（前缀缓存命中率、KV 显存占用、PD/DC 分离架构），结合 vLLM/SGLang 文档做技术验证。
4. **国产算力专项**：昇腾/寒武纪在 vLLM/SGLang 的适配状态、性能对比（吞吐、每 token 成本），判断国产卡进入统一调度池的时点。
5. **洗牌案例库与灰色中转站专项**：收集 2024–2026 中转站/聚合平台关停、转型、被并购案例，验证"纯差价模式出清"假设；灰色中转站改用 GitHub 项目、社区群组、备案查询等替代渠道核实差价模式与合规风险。
6. **趋势量化**：检索 DeepSeek 降价时间线（2024 年 5 月 V2、2025 年初 R1）、机构口径的推理成本下降曲线（SemiAnalysis/IDC）、OpenRouter/Together 流量收入数据（SimilarWeb）、OpenAI 兼容标准化普及率。

---

## 六、未能核实事项与限制声明

1. **web_search 在本会话中全部失败**（各分报告合计数十次调用返回"无结果"），因此本报告的一手证据全部来自 read_web_page 直接抓取的 8 个页面（vLLM 文档、Together/Fireworks/OpenRouter/DeepInfra 定价页、硅基流动价格页、阿里云百炼、腾讯云 TI）及 1 篇二手行业分析（Spheron 关于 DeepInfra）。所有二手/新闻/机构报告来源均缺失。
2. **明确未能核实的板块**：火山引擎方舟、百度千帆、无问芯穹 Infini-AI、Anyscale、Lambda Labs、Modal、RunPod、灰色商业中转站——其定位、模型生态、定价、融资、合规风险均未核实，对比表中以"❌ 未能核实"标注，未做推测性填充。
3. **明确未能核实的量化趋势**：2024–2025 降价潮时间线与幅度、推理成本下降曲线、国产算力适配里程碑与装机数据、OpenAI 兼容标准化普及率、国内中转站洗牌案例。
4. **证据性质提醒**：硅基流动性能宣称（延迟降 70%、吞吐 3–5x）为厂商自述，非独立测试；Spheron 关于 DeepInfra 的数据为二手行业分析；business.md 中"GPU 成本占比 60–80%""毛利率排序""低价档模型可能亏损"等为基于已验证价格的明确标注推断，不得作为已核实事实引用。
5. **补证最小路径**：在 web_search 可用后，依次检索——"DeepSeek V2 降价 2024"、"DeepSeek R1 各厂商降价"、"昇腾 vLLM 适配"、"寒武纪 推理 适配"、"OpenRouter 2025 报告"、"API 中转站 洗牌"；并对方舟/千帆/无问芯穹/Lambda/Modal/RunPod/Anyscale 官网逐一 read_web_page，即可将"未能核实"条目逐条升级为已核实。