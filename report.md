# 大模型中转算力池调研报告

> 调研时间：2026-09-03。本报告基于三个维度的公开文档调研汇总；事实性陈述均来自本次实际读取成功的来源，未能核实的内容明确标注【推断/存疑】，未虚构任何数据。

## 一、现状总览

"大模型中转"已形成成熟生态：上游是开源中转平台（One API 系）与商业/托管网关（Cloudflare AI Gateway、LiteLLM 等），下游是推理引擎与弹性调度层（vLLM/TGI、Kubernetes+KEDA）。**核心共识：中转平台本身不实现算力池，而是以"统一 OpenAI 格式网关 + 渠道池（Channel/Deployment）"绑定下游推理集群**，扩容靠增加渠道或下游实例。已核实的开源事实标准为 One API（GitHub 约 36.7k Star、6.9k Fork、1,210 次提交，维护者 songquanpeng）；商业侧 Cloudflare AI Gateway 与开源侧 LiteLLM 的机制有官方文档支撑，其余产品（OpenRouter、Kong、AWS Bedrock、Vertex AI）本次未能核实细节。

## 二、三大维度分述

### 维度一：开源中转平台生态

- **One API（songquanpeng/one-api）**：Go 实现、单可执行文件 + Docker 部署，将多供应商统一为标准 OpenAI API 格式，用于 key 管理与二次分发。规模已核实（见上）。
- **New API（Calcium-Ion/new-api）**：One API 衍生分支，自称"下一代 LLM 网关与 AI 资产管理"，多语言 README；Star/版本等未能核实【存疑】。
- 关键机制（源自 One API 系公开描述）：统一 API 格式转换；渠道（Channel）管理 + 权重分配 + 故障自动切换；令牌/额度计费体系；主从多机部署。**配额池共享、动态扩容的官方支持程度未能核实**【存疑】。

### 维度二：商业网关与托管中转服务

- **Cloudflare AI Gateway（已核实，仅 SaaS，未发现自托管）**：定位"观察与控制层"（analytics、caching、rate limiting、model fallback）。支持动态路由（基于条件/配额/回退，可视化或 JSON 配置）与模型/提供商回退链；可接入 GitHub Copilot CLI、OpenAI Codex 等编码代理做统一入口与计费。
- **LiteLLM Router/Proxy（已核实，开源可自托管）**：跨多 deployment 负载均衡；内置冷却（cooldown）、回退（fallback）、超时、重试（固定 + 指数退避）；支持按历史延迟窗口路由；生产环境用 Redis 共享冷却状态与 tpm/rpm 用量限额；`model_list` 实现"对外模型名 → 真实供应商"映射。
- **未能核实**：OpenRouter（文档读取失败，仅能推断为托管聚合、按 token 统一计费【推断】）、Kong AI Gateway（404）、AWS Bedrock/Vertex AI（无可用页面）、成本优先路由细节【存疑】。

### 维度三：底层算力池调度技术

- **已核实**：TGI 支持流式输出，以 `--max_concurrent_requests` 限流让客户端感知过载自行背压（引擎内不无限排队）；KEDA（v2.16）基于 HPA 按队列深度等外部指标扩缩容，文档明确警告缩容可能杀死已运行近 3 小时的长任务副本，需用容器生命周期钩子优雅退出——对 LLM 长推理尤为关键；LiteLLM Router 是"LLM 感知"的 L7 网关（token 级计量、模型级路由、三类 fallback 与上下文窗口预检）。
- **未能核实（一般认知，标注存疑）**：vLLM 的 continuous batching/PagedAttention、SGLang 的 RadixAttention、Ray Serve、KServe、Envoy/Nginx 的 LLM 网关实践；TTFT/TPOT/吞吐量具体数值（不引用任何数字）；抢占式实例落地案例。推断：通用 LB（Nginx/Envoy）适合流量入口，LiteLLM 类网关适合模型池路由+计量，实践中常组合使用。

## 三、共性架构模式总结

三个维度收敛出同一架构范式：**统一网关（OpenAI 兼容 API 入口）→ 渠道池（Channel/Deployment 多供应商绑定）→ 路由策略（权重/延迟/优先级/配额）→ 故障转移与重试（冷却/回退/指数退避）→ 弹性调度（KEDA 按队列扩缩容 + 引擎限流背压）→ 计量计费（令牌额度/tpm-rpm 限额）**。算力池以"渠道 = 下游推理集群入口"的形式被网关引用，网关层与推理层通过 OpenAI 兼容协议解耦。

## 四、差距与风险点

1. **证据缺口**：OpenRouter、Kong、AWS/Google 云平台、vLLM/SGLang/Ray/KServe 官方文档均未核实，成本优先路由、配额池共享、动态扩容等关键能力证据不足。
2. **缩容中断长任务**（已核实风险）：KEDA/HPA 缩容可能杀死长推理任务，需优雅退出机制。
3. **托管 SaaS 锁定**（推断）：Cloudflare 类服务存在数据出向与供应商锁定；自托管方案需自行运维 Redis 与代理集群。
4. **引擎过载处理**：TGI 模式依赖客户端背压，网关层需配套排队策略，否则过载直接失败。

## 五、可借鉴的落地建议

1. **网关层**：采用 LiteLLM Router 模式（model_list 映射 + Redis 共享冷却/限额 + 延迟窗口路由），或自研 One API 系渠道池逻辑，统一 OpenAI 格式入口。
2. **调度层**：KEDA 按队列深度扩容 + 容器 preStop 生命周期钩子优雅排空在途请求，避免缩容杀任务。
3. **推理层**：接入 vLLM/TGI 等 OpenAI 兼容引擎，引擎内限流 + 客户端背压，网关层做排队与重试分工。
4. **计量与成本**：以 tpm/rpm 限额 + 令牌额度绑定渠道；成本优化可探索"P99 延迟约束下选最便宜供应商"策略【推断，需核实】。
5. **后续核实**：补齐 vLLM/SGLang/Ray/KServe 官方文档、OpenRouter 与 Kong 文档、LiteLLM 成本路由与预算章节，再定论成本与弹性细节。

---
*核实来源：github.com/songquanpeng/one-api；developers.cloudflare.com/ai-gateway（含 dynamic-routing、fallbacks）；docs.litellm.ai/docs/routing 与 /docs/proxy/reliability；huggingface.co/docs/text-generation-inference/conceptual/streaming；keda.sh/docs/2.16/concepts/scaling-deployments。其余来源读取失败，不作为证据。*