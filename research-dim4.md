# 维度 4：生态与趋势（代表性玩家商业模式、算力池规模、行业趋势）调研笔记

> 调研日期：2026-09-03
> 说明：本文件为团队调研的维度 4 笔记。每条事实标注来源与验证状态；「已验证」指已通过 read_web_page 读取页面正文，「未核实」指仅有搜索摘要或读取失败。推断均明确标注。
> 调研对象：OpenRouter、Together AI、Fireworks、Groq、硅基流动 SiliconFlow、DeepInfra。

---

## 1. 结论摘要

- 代表性玩家可分为两类商业模式：**纯中转/聚合层（OpenRouter）** 与 **自营算力池 + 模型服务（Together AI、Fireworks、Groq、DeepInfra、硅基流动）**。后者普遍采用「按 token 计费的 Serverless 推理 + 按 GPU 秒计费的按需部署」双轨定价。
- 算力池规模信号：Groq 官网自述「正在建设数百兆瓦（hundreds of megawatts）容量」；OpenRouter 官网自述 300T+ 月 token、1000 万+ 用户、80+ 供应商、500+ 模型。其余厂商未在本次读取的页面中披露 GPU 数量，属未核实项。
- 硬件路线分化：Groq 主打自研 LPU 推理芯片、现推出 LPX 与 NVIDIA 新一代 GPU 协同；Fireworks 的按需部署定价页显示其算力池含 H100/H200/B200/B300/GB300 等 NVIDIA 全系 GPU；DeepInfra 以图像/多模态模型按张定价为特色。
- 国产算力与价格分层：硅基流动以「模型价格中心」形式聚合 deepseek-ai、Z-ai、moonshotai、Qwen、ByteDance、Tencent、Baidu 等多家国产模型，并引入**分时段定价**（如 DeepSeek-V4-Flash 夜间 2-8 点半价）与**缓存命中低价**，是国产卡适配与算力消纳的典型商业形态。
- 行业趋势（推断为主）：推理成本持续下降（分时段折扣、缓存定价、MoE 小参数模型低价）；算力池化走向标准化（OpenAI 兼容 API + 按 token/按 GPU 秒的统一计费）；国产模型与国产芯片生态通过聚合平台加速适配。

---

## 2. 已验证事实（含来源）

### 2.1 OpenRouter —— 纯中转聚合层

来源：https://openrouter.ai/ （已读取正文，2026-09-03）

- 定位「The Unified Interface For Every Model」：通过单一统一接口调用文本、图像、视频、音频模型。
- 平台规模自述：**300T+ 月 token、10M+ 全球用户、80+ 供应商、500+ 模型**。
- 核心卖点：多供应商分布式基础设施，**某供应商宕机时自动回退（fall back）到其他供应商**；边缘部署降低延迟。
- 商业模式：聚合第三方模型并按 token 转售，用户只需一个 API Key（推断：赚取路由/加价差价，平台未直接披露分成比例，未核实）。

来源：https://openrouter.ai/models （已读取正文，2026-09-03）

- 模型目录示例：Meta Muse Spark 1.3 Contributor，1.05M 上下文，$0.10/M 输入 token、$0.20/M 输出 token；Recraft 图像模型从 $0.12/张 起。
- 说明 OpenRouter 的定价由各上游供应商决定，平台展示统一比价目录。

### 2.2 Together AI —— 自营算力池 + 模型服务

来源：https://www.together.ai/pricing （已读取正文，2026-09-03）

- 提供 Serverless Inference、Provisioned Throughput、Dedicated Inference、GPU Clusters、Fine-Tuning 等多档产品。
- 价格示例（每 1M token）：Qwen3.5-122B-A10B $6.00（Batch $10.00）；Qwen3.5-397B-A17B $8.00（Batch $20.00）；另有 $7.50 档位模型（名称被截断）。
- 官网同时宣传「按需 B200 现已上线 GPU Clusters」、正在服务 MiniMax-M3、并发布 DeepSeek V4 Pro 0813 与 GPT-5.6 Sol 的 DeepSWE 对比——说明其算力池以 NVIDIA 新一代 GPU（B200 等）为主（该点属页面展示事实，GPU 总量未披露）。

### 2.3 Fireworks —— 自营算力池，按 token + 按 GPU 秒双轨

来源：https://fireworks.ai/pricing （已读取正文，2026-09-03）

- **Serverless Inference**：按 token 计费、零冷启动、后付费，新用户 $1 免费额度；Embeddings 按参数量分档：≤150M 参数 $0.008/1M 输入 token，150M-350M $0.016，Qwen3 8B $0.1。
- **Training**：LoRA SFT $0.50（≤16B 参数）到 $10.00（>300B，如 DeepSeek V3、Kimi K2）每 1M 训练 token；全参 SFT 为 2 倍价。
- **On-Demand Deployments（按 GPU 秒计费）**，GPU 时价（美元/小时，8 月 31 日前 → 9 月 1 日起）：
  - H100 80GB：$7.00 → $8.00
  - H200 141GB：$7.00 → $8.00
  - B200 180GB：$10.00 → $13.00
  - B300 288GB：$12.00 → $15.00
  - GB300 288GB：$18.00 → $20.00
- 区域受限部署加收 1.5 倍溢价。**9 月起全线涨价 14%-30%**，是本次调研中唯一观察到明确涨价的厂商（推断：反映高端 GPU 供需紧张或成本上升）。

### 2.4 Groq —— 自研 LPU 芯片 + 兆瓦级算力池

来源：https://groq.com/ （已读取正文，2026-09-03；https://groq.com/pricing 读取失败，Redirect was cancelled，定价细节未核实）

- 自我定位「premier neocloud for fast inference」；首创 LPU（Language Processing Unit）推理芯片，现推出 **LPX**，与 NVIDIA 新一代 GPU 协同工作。
- 算力池规模自述：**「正在建设数百兆瓦（hundreds of megawatts）的容量」**——这是本次调研中唯一给出量级规模的厂商表述。
- 主张「Fast or affordable is no longer a tradeoff」——推理速度与成本可兼得。

### 2.5 硅基流动 SiliconFlow —— 国产模型聚合 + 分时段/缓存定价

来源：https://siliconflow.cn/pricing （已读取正文，2026-09-03）

- 以「模型价格中心」一屏聚合多家国产模型厂商（deepseek-ai、Z-ai、moonshotai、Qwen、MiniMaxAI、ByteDance、Tencent、Baidu、Stepfun-ai、inclusionAI 等），覆盖对话、生图、语音、视频四类模型——典型的多模型聚合中转形态。
- 对话模型价格示例（¥/M token，输入/输出/缓存命中）：
  - DeepSeek-V4-Flash：¥1.50/¥4.50/¥0.15（2-8 点），¥3.00/¥9.00/¥0.30（其余时段）——**分时段定价，夜间半价**
  - DeepSeek-V4-Pro：¥12.00/¥24.00/¥1.00
  - DeepSeek-V3.2：¥4.00/¥6.00/¥0.40
  - GLM-5.2：¥8.00/¥28.00/¥2.00
  - Kimi-K2.7-Code：¥6.50/¥27.00/¥1.30
  - Qwen3.5-397B-A17B：¥1.20/¥7.20（<128k），¥3.00/¥18.00（≥128k）
  - Qwen3.5-122B-A10B：¥0.80/¥6.40（<128k），¥2.00/¥16.00（≥128k）
  - Qwen3.5-35B-A3B：¥0.40/¥3.20（<128k），¥1.60/¥12.80（≥128k）
- 生图按张计价（如 Z-Image-Turbo ¥0.10/张、Qwen-Image ¥0.30/张）；视频模型 Wan2.2-I2V/T2V-A14B ¥2.00/个；部分 ASR/语音模型免费。
- 观察：MoE 小激活参数模型（Qwen3.5-35B-A3B 等）价格显著低于大模型，且长上下文（≥128k）加价——反映「稀疏激活降本」与「长上下文溢价」两个定价趋势。
- 说明：硅基流动的「AI 算力运营服务（Token 工厂）」一体化模式已在维度 3 笔记中记录（异构国产算力接入、秒级扩缩容），此处不再重复。

### 2.6 DeepInfra —— 按张/按 token 计费的推理云

来源：https://deepinfra.com/pricing （已读取正文，2026-09-03）

- 定位「Simple Pricing, Deep Infrastructure」；部分语言模型按 token 计费，图像模型按张计费。
- 图像模型价格示例：FLUX-2-max $0.07/张；FLUX-2-pro $0.015/张；FLUX-1.1-pro $0.04/张；FLUX-1-dev $0.009 × (w/1024) × (h/1024) × (iters/25)——**按分辨率与迭代次数线性计价**。
- 融资信号：官网公告「DeepInfra 完成 $1.07 亿 B 轮融资，用于扩展推理云」——说明推理云赛道处于资本扩张期。

---

## 3. 推断（非直接证据，明确标注）

1. **OpenRouter 的盈利模式**：聚合 80+ 供应商转售 token，赚取路由差价或订阅费；平台未披露分成比例（未核实）。其「宕机自动回退」能力依赖多供应商冗余，是纯中转层相对自营算力池的差异化价值。
2. **自营算力池玩家的共同演进方向**：Together AI、Fireworks、DeepInfra 均同时提供 Serverless（按 token）与按需/专用（按 GPU 秒或 GPU 小时）计费，说明行业正把「算力池资源化」标准化为「GPU 秒」这一计价单位。
3. **Fireworks 9 月涨价**：H100/B200/B300 全线涨价 14%-30%，推断反映高端 GPU 供给紧张或推理需求上升；与「推理成本下降」的总体趋势并存——**成本下降主要来自算法/稀疏化/缓存，而非硬件单价**。
4. **硅基流动的分时段定价**：夜间半价推断用于削峰填谷、提高算力池利用率（算力消纳），与维度 3 记录的「算力消纳/联合运营」合作模式互相印证。
5. **国产卡适配趋势**：硅基流动聚合国产模型厂商并运营异构国产算力（维度 3 已验证），推断国产芯片（如华为昇腾、寒武纪等）通过此类平台获得商业化适配通道；本次未读取到具体国产卡型号清单，未核实。

---

## 4. 未能核实 / 未覆盖项

- **Groq 定价页**（https://groq.com/pricing）：读取失败（Redirect was cancelled），Groq 的具体 token 价格未核实。
- **Together AI 定价页**：读取失败（Redirect was cancelled），仅部分价格来自首次成功读取（见 2.2）；Batch API 折扣、Provisioned Throughput 定价细节缺失。
- **各厂商 GPU 总量**：除 Groq「数百兆瓦」与 OpenRouter「80+ 供应商」外，未获取到任何厂商的 GPU 卡数/总算力官方数字。
- **OpenRouter 的分成比例、供应商结算条款**：未获取。
- **国产卡（昇腾/寒武纪等）在硅基流动算力池中的具体占比与型号**：未获取。
- **多轮 web_search 均返回「无公开结果」**，融资/新闻类信息仅来自 DeepInfra 官网公告与各官网首页，未交叉验证第三方报道。

---

## 5. 行业趋势判断（综合以上证据 + 维度 1-3 笔记）

1. **推理成本下降是多因素叠加**：分时段折扣（硅基流动）、缓存命中低价（硅基流动、OpenRouter 生态）、MoE 稀疏激活低价档（Qwen3.5-35B-A3B ¥0.40/M 输入）、按分辨率/迭代计费（DeepInfra）——成本下降主要来自调度与算法优化，而非硬件降价（Fireworks 反而涨价）。
2. **算力池化标准化**：OpenAI 兼容 API + 「按 token / 按 GPU 秒」双轨计价正在成为事实标准；GPU 秒计价（Fireworks On-Demand、Together GPU Clusters）把算力池变成可编程资源。
3. **硬件路线分化与融合**：Groq 自研 LPU/LPX 与 NVIDIA GPU 协同；Fireworks/Together 以 NVIDIA H/B/GB 系列为主力；国产侧以硅基流动为代表的聚合平台承载国产模型与国产算力适配。
4. **中转层与算力池层互相渗透**：纯中转（OpenRouter）靠多供应商冗余取胜，自营算力池厂商（Together/Fireworks/Groq/DeepInfra）则向上提供统一 API；融合层（维度 3）是两者合流的产物。