# 分支二调研：算力池化与调度

- 调研日期：2026-09-03
- 调研方式：web_search 检索 + read_web_page 读取原文
- 说明：本会话中部分 web_search / read_web_page 调用未成功完成（执行记录中有失败通知），凡未能读取到原文的内容一律标注为"未核实"，不虚构来源与数据。

---

## 执行摘要

本分支围绕"GPU 算力池化与调度"展开，重点覆盖 Kubernetes + GPU 调度（volcano、k8s-device-plugin）、vLLM 分布式推理、Ray 集群、弹性算力平台（阿里云弹性 GPU、AWS 等）与异构算力纳管。本会话成功读取到三个高价值来源的原文：Ray 官方 GitHub 仓库、vLLM 官方文档、NVIDIA k8s-device-plugin GitHub 仓库，均形成"已验证事实"。Volcano 调度器、云厂商弹性 GPU 产品等方向因检索/读取未完成，列为"未核实"，需后续补充。

---

## 一、已验证事实（附来源URL）

### 1. Ray 集群（分布式运行时 + AI 库）

来源：https://github.com/ray-project/ray （本会话 read_web_page 读取成功）

- Ray 官方定位为 "AI compute engine"（AI 计算引擎），由核心分布式运行时（core distributed runtime）与一组 AI 库（AI Libraries）组成，用于加速 ML 工作负载。
- 核心抽象：Tasks（集群中执行的无状态函数）、Actors（集群中创建的有状态工作进程）、Objects（跨集群可访问的不可变值）。
- AI 库包括：Data（可扩展 ML 数据集）、Train（分布式训练）、Tune（可扩展超参调优）、RLlib（可扩展强化学习）、Serve（可扩展、可编程的服务/推理）。
- 监控与调试：Ray Dashboard 用于监控应用与集群；Ray Distributed Debugger 用于调试。
- 项目规模（页面展示数据）：43.7k stars、8.0k forks、Apache-2.0 许可证。

### 2. vLLM 分布式推理

来源：https://docs.vllm.ai/en/latest/ （本会话 read_web_page 读取成功）

- vLLM 官方定位为 "fast and easy-to-use library for LLM inference and serving"（快速易用的 LLM 推理与服务库）。
- 起源：最初由 UC Berkeley Sky Computing Lab 开发，现已发展为拥有 2000+ 贡献者的活跃开源项目。
- 核心技术：PagedAttention；官方文档称 continuous batching（连续批处理）可在 LLM 推理中实现 23x 吞吐提升，同时降低 p50 延迟。
- 学术背景：vLLM 论文发表于 SOSP 2023。
- 官方文档按用户类型提供 Quickstart Guide、User Guide、Developer Guide 等入口。

### 3. NVIDIA k8s-device-plugin（Kubernetes GPU 调度/设备注入）

来源：https://github.com/NVIDIA/k8s-device-plugin （本会话 read_web_page 读取成功）

- 该插件是 NVIDIA 官方 Kubernetes 设备插件，负责将 NVIDIA GPU 作为可调度资源暴露/注入给 Kubernetes 工作负载。
- 设备注入策略之一基于 NVIDIA Container Runtime（将设备注入容器的运行时方案）。
- 支持 CDI（Container Device Interface）注解方式：通过 CDI 注解选择要注入的设备；官方文档明确说明 CDI 方式**不要求** NVIDIA Container Runtime，但**要求**支持 CDI 的容器引擎。
- 该仓库为公开项目（3.9k stars、857 forks，页面展示数据）。

---

## 二、推断/观点（非本会话验证，仅供方向参考）

以下内容基于行业常识性认识，本会话未能读取对应原文，**不作为已验证事实**：

- Volcano 常被用作 Kubernetes 上的 AI/ML 批调度器（gang scheduling、队列管理、多租户资源配额），是"Kubernetes + GPU 调度"生态中的常见组件——推断，未核实。
- "Ray 管集群资源与弹性、vLLM 管推理服务"的组合是当前常见的分布式推理/算力池部署形态——推断，未核实。
- 阿里云弹性 GPU、AWS GPU 实例等云厂商方案通过实例级 GPU 弹性供给与共享（如 MIG、vGPU、时间片）实现算力池化——推断，未核实。
- 异构算力纳管（不同厂商 GPU、不同代际混部）通常依赖设备插件 + 调度器扩展 + 资源标签体系实现——推断，未核实。

---

## 三、检索情况与未能核实项（如实说明）

- 本会话中，部分 web_search 与 read_web_page 调用未成功完成（执行记录中存在失败通知），包括：Volcano 相关检索结果未能读取到原文页面；AWS / 阿里云弹性 GPU 专项检索未完成。
- 因此以下内容在本报告中为**未核实**：
  - Volcano 调度器的具体特性（gang scheduling、队列、优先级）与当前版本状态；
  - NVIDIA k8s-device-plugin 的完整能力清单（MIG 支持、时间片共享、多 GPU 拓扑等）；
  - vLLM 多节点/张量并行（tensor parallel、pipeline parallel）的官方部署细节；
  - 阿里云弹性 GPU、AWS GPU 实例的具体产品形态、定价与利用率优化数据；
  - 异构算力纳管与利用率优化方案的第三方实测数据。

---

## 四、风险与合规提示

- GPU 算力池化涉及多租户隔离问题（显存、算力、安全边界），设备注入方式（NVIDIA Container Runtime vs CDI）与容器引擎兼容性需提前验证，否则可能引发运行时故障。
- 若将算力池用于"大模型中转"商业场景，需注意云厂商服务条款对算力转售/共享的限制，以及出口管制（如 GPU 型号禁运）对异构纳管的约束。
- 共享 GPU 场景下，利用率优化（时间片、MIG）可能引入性能抖动，对在线推理 SLA 有影响，需在调研中区分"训练批任务"与"在线推理"两类负载。

---

## 五、后续可深入方向

1. 读取 Volcano 官方文档/GitHub（volcano.sh），验证 gang scheduling、队列与多租户能力，并与 kube-scheduler 默认 GPU 调度做对比。
2. 深入阅读 NVIDIA k8s-device-plugin 完整 README，核实 MIG、时间片共享、CDI 注解的详细用法。
3. 检索 vLLM 官方文档中分布式推理章节（多节点部署、tensor/pipeline parallel、与 Ray 的集成方式）。
4. 检索阿里云弹性 GPU（如 GPU 共享/弹性实例）与 AWS（如 EC2 GPU 实例、EKS + Karpenter 弹性伸缩）的官方产品文档与定价。
5. 检索 GPU 利用率优化方案（MIG、vGPU、时间片、Binpack 调度策略）的实测报告与社区案例。