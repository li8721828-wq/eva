# 大模型中转算力池技术调研笔记

> 调研日期：2026-09-02
> 调研范围：技术架构、调度算法、资源池化机制、开源项目（vLLM / Ray Serve / KServe / KubeAI / liteLLM 等）、业界博客与论文、性能指标。
> 证据标注：本笔记中「✔已核实」表示结论来自本次执行中成功读取的网页原文；「⚠未核实」表示来自一般性知识或未能成功读取的页面，需后续补充验证。

---

## 1. 总体架构（中转算力池视角）

大模型中转算力池（LLM relay / inference compute pool）通常由三层组成：

1. **接入/路由层（Gateway / Router）**：接收 OpenAI 兼容的 API 请求，做鉴权、限流、模型路由、负载均衡、失败重试与回退（failover）。
2. **推理服务层（Serving Layer）**：把模型实例（engine replica）池化，负责请求排队、动态批处理、流式响应（streaming）。
3. **资源池层（GPU Pool）**：多节点/多 GPU 的算力资源池化，负责显存管理（KV cache 分页）、模型加载/缓存、扩缩容。

✔已核实：Ray Serve 官方文档（docs.ray.io/en/latest/serve）描述其为「scalable model serving library for building online inference APIs」，框架无关，支持 streaming、dynamic request batching、multi-node/multi-GPU serving，适合作为中转池的 serving 层。

✔已核实：KServe 官网（kserve.github.io）定位为「the open-source standard for self-hosted AI」，在 Kubernetes 上统一提供 Generative 与 Predictive AI 推理，支持 vLLM / llm-d 高性能 LLM 后端、OpenAI 兼容协议、GPU 加速、模型缓存（降低加载时间与延迟）、KV Cache 卸载（CPU/磁盘，支持更长序列）。

✔已核实：vLLM 官方文档（docs.vllm.ai）描述其核心为 PagedAttention（KV cache 分页管理）与 continuous batching（连续批处理），官方博客称其可在 LLM 推理中实现 23x 吞吐提升并降低 p50 延迟。

✔已核实：liteLLM 官方文档（docs.litellm.ai）描述其为开源库，提供统一接口调用 100+ LLM（OpenAI、Anthropic、Vertex AI、Bedrock、Ollama、Azure OpenAI 等），统一输出 OpenAI Chat Completions 格式；内置 Router 支持跨部署的 retry / fallback；自托管 LLM Gateway（Proxy）提供虚拟密钥（virtual keys）、成本追踪、Admin UI、按 key/team/user 的预算与限流、guardrails（内容过滤、PII 脱敏）、可观测性集成（Langfuse、MLflow、Helicone 等）。→ 这正好覆盖中转池的接入/路由层能力。

---

## 2. 各层关键组件与实现原理

### 2.1 接入/路由层（Gateway / Router）

✔已核实（liteLLM）：
- 统一 OpenAI 格式接口，屏蔽多供应商差异；
- Router 组件：负载均衡 + 自动 fallback + 重试；
- Proxy 模式：虚拟密钥、预算/限流、成本追踪、Admin UI、guardrails、可观测性集成；
- 企业版额外提供 SSO/SAML、审计日志、多团队管理。

⚠未核实（一般性知识，待验证）：One API / new-api 等国内中转项目也提供类似的多渠道聚合、密钥管理与计费能力，但本次未检索到其官方文档原文，未列入对比表。

### 2.2 推理服务层（Serving Layer）

✔已核实（Ray Serve）：
- 框架无关的模型服务库，支持 PyTorch / TensorFlow / Keras / Scikit-Learn 及任意 Python 业务逻辑；
- 特性：response streaming、dynamic request batching、multi-node/multi-GPU serving；
- 可通过 Kubernetes Operator 部署到 K8s；与 BentoML、MLflow 等工具定位不同（Serve 侧重模型组合与框架无关）。

✔已核实（vLLM）：
- PagedAttention：KV cache 分页管理，提高显存利用率；
- continuous batching：动态批处理，提升吞吐；
- 支持 Qwen-Math 等大量模型（官方文档列出完整支持列表）。

⚠未核实：vLLM 具体吞吐/延迟基准数字（如 tokens/s、TTFT）未在本次读取的页面中获取到数值，需后续读取 vLLM 官方 benchmark 页面或论文原文核实。

### 2.3 资源池层（GPU Pool）

✔已核实（KServe）：
- 基于 Kubernetes，提供统一推理平台；
- 优化后端：vLLM 与 llm-d；
- 模型缓存：减少加载时间、降低频繁使用模型的延迟；
- KV Cache 卸载：KV cache 可卸载到 CPU/磁盘，支持更长序列处理；
- 已加入 CNCF，被多行业生产使用。

⚠未核实：KServe ServingRuntime CRD 的具体字段（runtime 版本、后端配置细节）——kserve.github.io 的 serving_runtimes 页面无可读文本，未验证。

---

## 3. 调度算法与资源池化机制（要点归纳）

⚠未核实（以下为基于已核实文档特性的一般性归纳，具体算法细节待论文/源码验证）：
- 请求级调度：连续批处理（continuous batching）在请求粒度动态组批，而非等待固定 batch 满；
- 显存级调度：PagedAttention 以 page 为单位管理 KV cache，近似操作系统的虚拟内存分页，减少显存碎片与浪费；
- 实例级调度：Ray Serve / KServe 支持多副本（replica）与扩缩容，配合 K8s 调度器做 GPU 资源分配；
- 路由级调度：Router 层做负载均衡与 fallback，可结合健康检查、队列长度、成本等策略（liteLLM 的 Router 已核实支持负载均衡与 fallback，具体策略权重算法未核实）。

---

## 4. 开源项目对比（初步）

| 项目 | 定位 | 已核实要点 | 证据状态 |
|------|------|-----------|---------|
| vLLM | 推理引擎 | PagedAttention、continuous batching、高吞吐 | ✔已核实（官方文档） |
| Ray Serve | Serving 框架 | 框架无关、streaming、动态批处理、多节点/多 GPU | ✔已核实（官方文档） |
| KServe | K8s 推理平台 | CNCF 项目、vLLM/llm-d 后端、模型缓存、KV cache 卸载 | ✔已核实（官网） |
| KubeAI | K8s 上的 LLM 推理 Operator | 未获取到可读文档（raw README 404） | ⚠未核实 |
| liteLLM | Gateway / Router | 统一 OpenAI 接口、100+ 模型、虚拟密钥、成本追踪、fallback | ✔已核实（官方文档） |

---

## 5. 性能指标（初步）

⚠未核实：本次执行中未能从成功读取的页面中提取到具体性能数值（如吞吐 tokens/s、TTFT、首 token 延迟、并发扩展曲线）。vLLM 博客宣称 23x 吞吐提升（✔已核实该宣称存在于官方博客/文档页面），但基准测试的完整数据与复现条件未核实。

---

## 6. 局限性与未核实项

1. **KubeAI**：raw.githubusercontent.com 的 README 返回 404，官方文档页（kubeai.org）读取被重定向取消，KubeAI 的架构与特性未核实。
2. **KServe ServingRuntime**：kserve.github.io 的 serving_runtime 页面无可读文本，具体 CRD 字段（如 runtime 版本、后端配置）未验证。
3. **GitHub 页面上的 star/fork 数字**：来自页面快照，可能随时间变化，仅作参考；本次未核实。
4. **中转层具体开源实现**：liteLLM 已核实；One API / new-api 等国内项目本次未检索到官方文档原文，未列入对比。
5. **各项目最新版本特性与性能基准**：未做版本级核实；具体吞吐/延迟数值缺失。
6. **调度算法细节**：PagedAttention 与 continuous batching 的原理性描述来自官方文档/博客，论文级细节（如调度策略权重、队列管理）未核实。

**下一步最小动作**：
- 重新抓取 KubeAI 官方文档（kubeai.org 或 GitHub 仓库主页的镜像/缓存），补齐第 4 节缺口；
- 读取 KServe ServingRuntime 文档页的替代入口（如 GitHub 源码中的 servingruntime CRD 定义）；
- 读取 vLLM 官方 benchmark 页面或论文（SOSP 2023）获取具体性能数值；
- 检索 One API / new-api 官方文档，补充中转层对比。