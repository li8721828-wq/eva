# 行业现状与趋势调研笔记：大模型中转算力池市场（2025–2026）

> 调研日期：2026-09-03
> 调研方法：web 搜索 + 网页阅读，注明来源。
> **核实状态总览**：本次调研中 web 搜索多次返回"无公开结果"，部分网页读取失败（重定向取消）。因此本笔记严格区分【已核实】与【未能核实】两部分。已核实内容均来自本次会话中成功读取的页面原文；未能核实部分明确标注，未做任何编造。

---

## 一、已核实信息（来源：本次会话成功读取的页面）

### 1. 聚合平台定价现状 —— SiliconFlow（硅基流动）

来源：https://siliconflow.cn/pricing （2026-09-03 读取）

**厂商聚合广度**：SiliconFlow 定价页聚合了多家模型厂商，包括 DeepSeek、智谱（Z-ai / GLM）、月之暗面（Kimi）、阿里（Qwen）、MiniMax、阶跃（Stepfun）、百度、字节跳动（ByteDance）、腾讯混元（Hunyuan）、美团（longcat）、inclusionAI、电信星辰（XingChen）等；模型类型覆盖对话、生图、语音、视频。

**定价结构特征（页面原文数据）**：
- **分时段定价（闲时折扣）**：DeepSeek-V4-Flash 输入 ¥1.50/M tokens（2:00–8:00 时段）、¥3.00（其他时段）；输出 ¥4.50 / ¥9.00；缓存命中 ¥0.15 / ¥0.30。
- **缓存定价**：多数主流模型单列"缓存价格"一档（如 DeepSeek-V4-Pro 缓存 ¥1.00、GLM-5.2 缓存 ¥2.00、Kimi-K2.7-Code 缓存 ¥1.30、MiniMax-M2.5 缓存 ¥0.21）。
- **长上下文加价**：GLM-5.1、Qwen3.5 系列等按输入长度分段计价（如 Qwen3.5-397B-A17B 128k 内 ¥1.20、超 128k ¥3.00）。
- **免费模型引流**：GLM-Z1-9B、Hunyuan-MT-7B、BAAI 系列（bge-m3、reranker）、星辰 ASR 系列等标注"免费"。
- 其他代表价格：DeepSeek-V4-Pro ¥12.00/¥24.00；DeepSeek-V3.2 ¥4.00/¥6.00；GLM-5.2 ¥8.00/¥28.00；Kimi-K2.7-Code ¥6.50/¥27.00；MiniMax-M2.5 ¥2.10/¥8.40；Step-3.5-Flash ¥0.70/¥2.10；Qwen3.5-35B-A3B ¥0.40/¥3.20（128k 内）。

**观察（基于页面事实的归纳）**：国内聚合平台已形成"多厂商聚合 + 分时段定价 + 缓存定价 + 免费模型引流"的典型定价结构；价格竞争体现在闲时折扣与缓存档位上。

### 2. 开源网关项目（来源：GitHub README，本次会话读取）

| 项目 | 定位 / 核心能力（页面原文） | 备注 |
|---|---|---|
| new-api（QuantumNous/new-api） | "统一 AI 模型中心，聚合与分发"；支持将各类 LLM 互转 OpenAI / Claude / Gemini 兼容格式 | 环境变量体现中继架构细节：RELAY_TIMEOUT（中继超时）、RELAY_PROXY（代理转发）、USER_CONTENT_REQUEST_TIMEOUT、STREAMING_TIMEOUT（流式超时，默认 300s）、STREAM_SCANNER_MAX_BUFFER_MB（流扫描器每行缓冲上限） |
| LiteLLM（BerriAI/litellm） | "The fastest, litest AI Gateway"；Rust 核心 + Python SDK；100+ LLM API，OpenAI（或原生）格式；成本追踪、guardrails、负载均衡、日志 | 支持 Bedrock、Azure、OpenAI、Anthropic、VertexAI、vLLM、Nvidia NIM 等；README 列出大量 provider（Fireworks、FriendliAI、GitHub Models、Gemini 等） |
| Portkey Gateway（Portkey-AI/gateway） | "Route to 1,600+ LLMs, 50+ AI Guardrails"；集成 guardrails 的 AI 网关 | 约 12.9k stars / 1.3k forks（README 页面显示） |
| Higress（alibaba/higress） | "AI Native API Gateway"；CNCF Sandbox 项目 | 深度集成 Nacos、ZooKeeper、Consul、Eureka、Dubbo、Sentinel 等微服务生态，企业级微服务网关向 AI 网关演进 |

**观察（基于页面事实的归纳）**：开源网关呈三层格局——个人/小型中转站（new-api 等 one-api 系）、开发者级网关（LiteLLM、Portkey，主打多 provider 适配与成本/负载管理）、企业级网关（Higress、Kong、APISIX 等，主打微服务生态与治理能力）。

---

## 二、未能核实部分（明确标注，未编造）

以下内容在本次调研中**未能通过可靠来源核实**（web 搜索均返回"无公开结果"，或页面读取失败）：

1. **价格战具体报道**：搜索"大模型 API 中转 价格战 2025"等关键词无结果，未能获取 2025–2026 年价格战的具体文章、降价幅度数据。
2. **海外商业平台**：OpenRouter、DeepInfra、Together AI、Groq 的最新模型接入数量、商业模式、稳定性信息未能核实。
3. **国内云厂商平台**：火山方舟、阿里百炼、智谱开放平台的商业模式（按量计费、倍率计价、充值体系）细节未能核实。
4. **Kong AI Gateway**：官方文档读取失败（重定向取消），其 AI 代理插件细节未能核实。
5. **one-api 项目详情**：未能读取到仓库页面。
6. **企业自建 vs 第三方中转的取舍**：相关分析文章未能获取。
7. **新兴趋势（模型路由智能调度、AI Gateway 企业级落地）**：行业报告未能获取。

---

## 三、基于已核实信息的初步推断（标注为推断，非核实结论）

1. **聚合平台定价呈三层结构**：基础按量价 + 缓存命中价 + 分时段（闲时）折扣；免费模型作为获客入口。这间接说明中转/聚合市场的竞争焦点已从"接入数量"转向"成本结构优化"。
2. **网关能力重心**：从已核实的开源项目看，成本追踪、负载均衡、流式处理、guardrails 是共性能力，与"模型路由智能调度、成本优化"的趋势方向一致。
3. **企业级落地路径**：Higress 进入 CNCF Sandbox 并深度绑定微服务生态，表明 AI Gateway 正在从"开发者工具"走向"企业基础设施"。

---

## 四、来源清单

**已核实来源（本次会话成功读取）**：
- SiliconFlow 定价页：https://siliconflow.cn/pricing
- new-api：https://github.com/QuantumNous/new-api
- LiteLLM：https://github.com/BerriAI/litellm
- Portkey Gateway：https://github.com/Portkey-AI/gateway
- Higress：https://raw.githubusercontent.com/alibaba/higress/main/README.md

**未能读取 / 无结果**：
- Kong AI Gateway 文档（重定向取消）
- 所有 web 搜索（多次返回"无公开结果"）
- 其余目标站点（OpenRouter、DeepInfra、Together AI、Groq、火山方舟、阿里百炼、智谱开放平台、one-api 等）

---

## 五、后续补充建议（最小下一步）

- 需要可用的 web 搜索服务，或由用户直接提供目标文章/报告 URL（如 OpenRouter 定价页、Kong 文档、行业报告链接），以便补齐"未能核实"部分。