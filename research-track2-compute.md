# 下层算力池化与调度调研（research-track2-compute.md）

> 子任务：vLLM 分布式推理、Kubernetes GPU 调度（k8s-device-plugin、volcano）、Ray 分布式运行时、网关合流形态。
> 原则：每个来源必须实际读取成功才能列为「已验证」；读取失败一律标注「未能核实」，不编造来源、数据或结论。

---

## 一、已验证事实清单（附来源 URL）

### 1. vLLM 分布式推理（部分验证）

- **定位**：vLLM 官方文档首页自述为 "Easy, fast, and cheap LLM serving for everyone"，最初由 UC Berkeley Sky Computing Lab 发起，社区由 2000+ 贡献者维护。
  - 来源：https://docs.vllm.ai/en/latest/（已验证）
- **核心技术**：PagedAttention；continuous batching（官方博客称可实现 23x 吞吐提升并降低 p50 延迟）；SOSP 2023 论文。
  - 来源：https://docs.vllm.ai/en/latest/（已验证）
- **仓库形态**：vllm-project/vllm，Apache-2.0 许可，README 自述 "fast and easy-to-use library for LLM inference and serving"。
  - 来源：https://github.com/vllm-project/vllm（已验证）
- **注意**：vLLM 分布式推理专项文档页（tensor parallel / pipeline parallel / 多节点部署细节）本次读取失败，见「未能核实」清单。

### 2. Kubernetes GPU 调度：NVIDIA/k8s-device-plugin（已验证）

- **定位**：为 Kubernetes 的 DaemonSet，自动完成三件事——暴露集群每个节点的 GPU 数量、跟踪 GPU 健康状态、在集群中运行 GPU 容器。
  - 来源：https://github.com/NVIDIA/k8s-device-plugin（已验证）
- **设备注入策略**：`DEVICE_LIST_STRATEGY` 支持三种方式：
  - `envvar`（默认）：通过 `NVIDIA_VISIBLE_DEVICES` 环境变量选择注入设备；
  - `volume-mounts`：以卷挂载方式传递设备列表；
  - `cdi-annotations`：使用 CDI 注解，不依赖 NVIDIA Container Runtime，但需要支持 CDI 的容器引擎。
  - 来源：https://github.com/NVIDIA/k8s-device-plugin（已验证）
- **GPU 共享**：支持 CUDA Time-Slicing 与 CUDA MPS 两种共享访问方式（README 目录含 "Shared Access to GPUs / With CUDA Time-Slicing / With CUDA MPS"）。
  - 来源：https://github.com/NVIDIA/k8s-device-plugin（已验证）
- **配套能力**：gpu-feature-discovery 可自动生成节点标签；支持 helm 部署、ConfigMap 配置、按节点标签更新配置。
  - 来源：https://github.com/NVIDIA/k8s-device-plugin（已验证）

### 3. Ray 分布式运行时（已验证）

- **定位**：Ray 自述为 "AI compute engine"，由核心分布式运行时 + 一组 AI 库（Data、Train、Tune、RLlib、Serve）组成，用于加速 ML 工作负载。
  - 来源：https://github.com/ray-project/ray（已验证）
- **核心抽象**：Tasks（集群中执行的无状态函数）、Actors（集群中创建的有状态 worker 进程）、Objects（跨集群可访问的不可变值）。
  - 来源：https://github.com/ray-project/ray（已验证）
- **Ray Serve**：框架无关的模型服务库，用于构建在线推理 API；对 LLM 服务有响应流式、动态请求批处理、多节点/多 GPU 服务等优化；可通过 Kubernetes Operator 透明部署到 K8s。
  - 来源：https://docs.ray.io/en/latest/serve/index.html（已验证）

### 4. 网关合流形态：自建推理服务注册为「渠道/部署」与外部厂商 API 混编

- **LiteLLM 直接证据**：LiteLLM 官方文档声明 "LiteLLM supports all models on VLLM"；vLLM 提供 OpenAI 兼容端点，LiteLLM 通过 `model="hosted_vllm/..."` 路由调用自建 vLLM 服务。即网关把自建推理服务当作一个 provider 路由，与外部厂商 API 同池混编。
  - 来源：https://docs.litellm.ai/docs/providers/vllm（已验证）
- **one-api 数据模型**：采用 channel（渠道）与 ability（渠道-模型能力映射）分离设计；README 说明每个渠道支持的模型都需要专门的 ability 表记录，删除渠道需同步清理 ability，否则报「数据库一致性已被破坏」。渠道可指向不同上游，为自建 OpenAI 兼容端点混编提供了数据模型基础。
  - 来源：https://github.com/songquanpeng/one-api（已验证）
- **New API（one-api 增强分支）**：自述为 "unified AI model hub for aggregation & distribution"，支持把各类 LLM 交叉转换为 OpenAI 兼容、Claude 兼容或 Gemini 兼容格式；多机部署要求所有节点共享同一主数据库与 SESSION_SECRET，连接同一 Redis 的节点需使用相同 CRYPTO_SECRET。
  - 来源：https://github.com/QuantumNous/new-api（已验证）

---

## 二、未能核实清单

| 项目 | 说明 |
| --- | --- |
| vLLM 分布式推理专项文档 | https://docs.vllm.ai/en/latest/serving/distributed_serving.html 读取失败（Error: Redirect was cancelled），tensor parallel / pipeline parallel / 多节点部署细节未能核实 |
| volcano-sh/volcano | 本子任务会话中未成功读取任何 volcano 来源，其 GPU 调度/批处理调度细节未能核实 |
| 网关「添加自定义 OpenAI 兼容渠道」的具体操作路径 | one-api / New API 仓库 README 未展开渠道注册的 UI/API 操作细节，未能核实 |
| SiliconFlow / OpenRouter 定价 | 不在本子任务范围（由聚合平台定价子任务覆盖），本文件不涉及 |

---

## 三、合流形态初步结论（推断，非已验证）

基于已验证证据（LiteLLM 的 `hosted_vllm/` 路由 + one-api 的 channel/ability 数据模型），可推断合流形态为：**网关将自建推理服务（vLLM 等 OpenAI 兼容端点）注册为「渠道/部署」，与外部厂商 API 同池混编，统一对外提供 OpenAI 兼容接口并统一计量**。此为基于已验证证据的推断；具体注册操作路径与计量细节待补充验证。

---

## 四、后续补充建议

1. 重试读取 vLLM 分布式推理文档（处理重定向问题），核实 tensor parallel / pipeline parallel / 多节点部署细节。
2. 读取 https://github.com/volcano-sh/volcano 的 README 与 scheduler 文档，核实其 GPU 调度能力。
3. 读取 one-api / New API 文档站中「添加渠道」章节，核实自定义 OpenAI 兼容渠道的注册路径与混编计量方式。
4. 读取 vLLM 文档中 OpenAI-compatible server 章节，确认端点兼容性声明，作为合流形态的补充证据。

---

## 五、本次会话失败的 agent/工具调用记录

- `read_web_page`：https://docs.vllm.ai/en/latest/serving/distributed_serving.html → 失败（Error: Redirect was cancelled），未能读取。
- `read_web_page`：volcano-sh/volcano → 本会话未发起成功读取（无结果），标注未能核实。
- 注：本会话执行记录中另有若干 `read_web_page` 失败标注（执行完整性提示），具体 URL 未能全部复原，本文件仅记录可确证的一次失败与一次无结果。