# 商业平台调研笔记：LLM API 中转 / 聚合服务商（国内外）

- 调研日期：2026-09-03
- 说明：本笔记严格区分「已核实」（本次会话中有网页读取证据）与「未能核实」（页面访问失败或搜索无结果，仅一般性知识，明确标注为推断）。所有价格与结论以来源链接为准，未编造数据。

---

## 一、海外平台

### 1. OpenRouter（聚合路由，闭源）
- 商业模式（已核实）：统一 API 聚合市场上主流 LLM；**透传上游供应商价格**（pass-through pricing），统一计费与用量分析；支持加密货币充值；未使用 Credits 可在 24 小时内申请退款。
- 稳定性（已核实）：聚合多家供应商的 uptime，供应商故障时通过 fallback 提升可用性。
- 风险点：余额为预充值模式，但 24h 退款政策降低短期风险。
- 来源：https://openrouter.ai/docs/faq （2026-09-03 读取成功）

### 2. DeepInfra（推理云，按量计费）
- 商业模式（已核实）：按 token 计费（per-token），无订阅制。示例价格（每百万 token，输入/输出）：
  - Mistral-Small-3.2-24B-Instruct-2506：$0.075 / $0.20
  - Mistral-Small-24B-Instruct-2501：$0.05 / $0.08
  - Mistral-Nemo-Instruct-2407：$0.019 / $0.03
- 公司动态（已核实）：完成 $107M B 轮融资，扩张推理云规模。
- 来源：https://deepinfra.com/pricing （2026-09-03 读取成功）

### 3. Together AI（推理云 + GPU 集群）
- 商业模式（已核实）：Serverless 按每百万 token 计费；提供 **Batch API 折扣价**；另有 Provisioned Throughput / Dedicated Inference / GPU Clusters 等固定资源形态；微调按「训练数据集 token 数 × epoch 数 + 验证集 token 数」计费。
- 示例价格（每百万 token，输入/输出/批量）：
  - Qwen3.5-122B-A10B：$6.00 / $15.00 / $10.00
  - Qwen3.5-397B-A17B：$8.00 / $20.00 / $22.00
- 来源：https://www.together.ai/pricing （2026-09-03 读取成功）

### 4. Groq（LPU 推理）
- **未能核实**：pricing 页面访问失败（重定向取消），两次搜索均无结果。
- 一般性知识（推断，非本次核实）：Groq 以自研 LPU 硬件主打低延迟推理，按 token 计费，提供免费额度层。具体价格与充值体系需以官网为准。

---

## 二、国内平台

### 5. 智谱开放平台（BigModel）
- 模型矩阵（已核实）：GLM-5.3 / GLM-5.3-Flash（上下文 1M，最大输出 128K）、GLM-5.2、GLM-Image（图像生成）、GLM-OCR（单图≤10MB、PDF≤50MB、≤100 页）、GLM-ASR-2512（语音识别）、GLM-TTS（流式/非流式）、GLM-TTS-Clone（3 秒音色克隆）、GLM-Realtime（实时音视频）、GLM-4-Voice、Embedding-2、GLM-4、Emohaa、CodeGeeX-4、Rerank。
- 商业模式：按量计费（token/图像/时长等维度），官方价格页 open.bigmodel.cn/pricing 本次访问失败（403），**价格明细未能核实**。
- 来源：https://docs.bigmodel.cn/cn/guide/start/model-overview （已核实）；价格页未能核实。

### 6. 阿里云百炼（阿里百炼 / Bailian）
- 模型矩阵（已核实，来自百炼官方文档）：ASR 模型（qwen-audio-3.0-asr-flash-streaming / -file）、实时语音对话（qwen-audio-3.0-realtime-plus、qwen3.5-omni-plus）、向量模型（text-embedding-v4、qwen3.7-text-embedding、tongyi-embedding-vision-plus）、重排序（qwen3-rerank）；提供「模型广场」统一查看与调用千问、三方、领域及历史版本模型。
- 商业模式：按量计费，各模型在模型广场分别定价；文档含「首次调用千问 API」「动态限流」等指引，说明具备配额/限流体系。具体价格表本次未单独核实。
- 来源：阿里云百炼官方文档（已核实；该次读取的完整 URL 未留存，标注为百炼文档页）。

### 7. 硅基流动 SiliconFlow
- **未能核实**：计费文档访问失败（重定向取消），搜索无结果。
- 一般性知识（推断，非本次核实）：国内聚合推理平台，按量计费、支持充值，部分模型按倍率计价，提供免费模型额度。具体规则需以官方文档为准。

### 8. 火山方舟（Volcano Ark，字节跳动火山引擎）
- **未能核实**：搜索无结果。
- 一般性知识（推断，非本次核实）：字节跳动旗下大模型服务平台，按 token 按量计费，支持充值/资源包，提供豆包等模型。具体价格与体系需以官方为准。

### 9. 基于 one-api 的付费中转站（个人/第三方）
- **未能核实**：无具体站点可核实，未找到可信公开来源。
- 一般性知识（推断，基于 one-api 开源项目的设计模式）：充值-余额-倍率计价体系（按上游官方单价 × 倍率扣费），常见风险：
  - **跑路风险**：预充值余额无法追回，个人站点生命周期短；
  - **封号风险**：共享/转卖上游 key 违反上游服务条款，可能被上游封禁导致服务中断；
  - **成本转嫁**：通过倍率加价、利用上游批量折扣与缓存差价盈利，用户实际成本高于官方直连。

---

## 三、商业模式对比要点

| 平台 | 计费方式 | 充值/账户体系 | 稳定性与风险 | 核实状态 |
|---|---|---|---|---|
| OpenRouter | 按量，透传上游价 | Credits 预充值，24h 退款 | 多供应商 fallback，聚合计费 | 已核实 |
| DeepInfra | 按 token | 按量付费 | 推理云直营，$107M B 轮 | 已核实 |
| Together AI | 按 token + Batch 折扣 + 固定资源 | 按量 + 集群资源 | 推理云直营 | 已核实 |
| Groq | 按 token（推断） | 未核实 | 未核实 | 未能核实 |
| 智谱 BigModel | 按量（模型矩阵已核实） | 未核实（价格页 403） | 大厂直营，风险低 | 部分核实 |
| 阿里云百炼 | 按量，模型广场分模型定价 | 阿里云账户体系 | 大厂直营，风险低 | 部分核实 |
| SiliconFlow | 按量/倍率（推断） | 充值（推断） | 未核实 | 未能核实 |
| 火山方舟 | 按量（推断） | 充值/资源包（推断） | 未核实 | 未能核实 |
| one-api 中转站 | 充值-余额-倍率（推断） | 预充值 | 跑路/封号/成本转嫁风险高 | 未能核实 |

---

## 四、风险分析要点

1. **跑路风险**：预充值模式风险最高，尤其个人 one-api 中转站（余额不可追回）；OpenRouter 有 24h 退款政策缓解；智谱/百炼/火山等大厂平台跑路风险低。
2. **封号风险**：中转站共享/转卖 key 违反上游服务条款，可能被上游封禁；官方平台按实名/企业认证管理，合规性更好。
3. **成本转嫁**：中转站通过倍率加价、批量折扣差价、缓存差价盈利；官方平台价格透明但可能存在资源包/阶梯价。企业用量大时应对比直连成本。

---

## 五、信息来源（本次会话实际读取）

- https://openrouter.ai/docs/faq （OpenRouter FAQ，已读取）
- https://deepinfra.com/pricing （DeepInfra 价格页，已读取）
- https://www.together.ai/pricing （Together AI 价格页，已读取）
- https://docs.bigmodel.cn/cn/guide/start/model-overview （智谱模型概览，已读取）
- 阿里云百炼官方文档（模型矩阵页，已读取；完整 URL 未留存）
- 以下来源访问失败，未采用：https://open.bigmodel.cn/pricing （403）、https://groq.com/pricing （重定向取消）、https://docs.siliconflow.cn/cn/userguide/guides/billing/billing-overview （重定向取消）

---

## 六、未能核实项（Limitations）

- Groq 价格与计费体系：pricing 页访问失败，搜索无结果。
- SiliconFlow 计费/充值/倍率规则：文档访问失败，搜索无结果。
- 火山方舟计费体系：搜索无结果。
- 智谱价格明细：官方价格页 403。
- 阿里云百炼具体价格表：未单独核实。
- one-api 付费中转站：无具体可信站点来源，仅基于开源项目设计模式的推断。

**下一步最小需求**：提供可访问的官网价格页/计费文档（或允许访问上述被拦截的域名），即可补齐 Groq、SiliconFlow、火山方舟、智谱价格明细的核实。