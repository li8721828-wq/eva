# 维度 2：算力池层（GPU 算力调度与池化）调研笔记

> 调研范围：推理引擎（vLLM、SGLang、TGI、TensorRT-LLM）、GPU 集群调度（Kubernetes + GPU 插件、Ray、Volcano、Slurm）、算力池化/切分技术（MIG、时间片、弹性伸缩）、国内算力平台（阿里云 PAI、火山引擎、硅基流动、无问芯穹等）。
>
> 调研方法：web_search + read_web_page，逐条记录来源与验证状态。
>
> **验证状态总说明**：本次调研期间 web_search 多次返回空结果、read_web_page 多次遭遇 429 限流 / 重定向取消 / 404，大量条目未能核实，已在文中明确标注。标注口径：**已验证** = 本会话内成功读取页面正文；**片段级** = 仅来自搜索摘要，未读取正文；**推断** = 基于公开常识的合理推测，未经本次工具验证；**未能核实** = 尝试读取失败或无来源。

---

## 1. 推理引擎

### 1.1 vLLM
- **已验证 / 片段级**（来源：quant67.com《大模型基础设施工程》12 篇，搜索摘要）：
  - 核心机制为 PagedAttention（分页 KV 缓存）+ Continuous Batching（连续批处理）。
  - 技术脉络：Orca（OSDI 2022）提出 iteration-level scheduling（迭代级调度）；vLLM（SOSP 2023）将其与 PagedAttention 合并为通用引擎。
  - 论文报告的性能（A100、ShareGPT 负载）：相对 HuggingFace Transformers 约 14–24× 吞吐；相对 FasterTransformer / TGI 约 2.2–3.5×（绝对值随模型/上下文/硬件变化）。
  - 上述数字为论文/文章转述，**未读取正文核实**，标注为片段级证据。
- **片段级（观点）**：vLLM 是自建推理服务中工程完成度和社区活跃度最高的选择之一（来源：zdyedu.cn 博客摘要，属观点性内容）。
- **未能核实**：vLLM 官方文档（部署、量化、多卡张量并行等细节）本次未能成功读取。

### 1.2 SGLang / TGI / TensorRT-LLM
- **未能核实**：本次会话内未能成功读取三者官方文档（web_search 无结果、read_web_page 429/404）。
- **推断**（公开常识，未经本次工具验证）：
  - SGLang：主打 RadixAttention 前缀缓存、结构化输出加速，常与 vLLM 并列为主流开源引擎。
  - TGI（Text Generation Inference）：Hugging Face 出品的 Rust 实现推理服务器。
  - TensorRT-LLM：NVIDIA 的编译优化推理引擎，面向 TensorRT 生态与多卡部署。
  - 三者的具体能力、版本差异、性能对比数据均需后续补充官方来源核实。

---

## 2. GPU 集群调度

### 2.1 Kubernetes + NVIDIA GPU 插件（已验证）
- **已验证**（来源：NVIDIA 官方文档，本会话内成功读取）：
  - NVIDIA Kubernetes Device Plugin 原生支持 **GPU 时间片（time-slicing）**：管理员可为一块 GPU 定义一组副本（replicas），每个副本可独立分配给 Pod，实现 GPU 超卖与多工作负载交错执行。
  - 配套组件 **gpu-feature-discovery（GFD）** 用于发现并上报 GPU 特性（示例镜像 `nvcr.io/nvidia/k8s-device-plugin:v0.13.0-ubi8`）。
  - 文档含"Verifying the GPU Time-Slicing"验证章节，说明时间片是官方支持、可验证的池化手段。
- **推断**：时间片适合对延迟不敏感、可交错执行的推理/训练负载；代价是单任务性能下降、无严格隔离。

### 2.2 Volcano（已验证）
- **已验证**（来源：华为云 CCE 文档《Volcano调度器》，support.huaweicloud.com/usermanual-cce/cce_10_0193.html，本会话内成功读取）：
  - Volcano 支持**资源超卖（oversubscription）**，用于提升节点资源利用率。
  - 超卖量计算方式（oversubscription_method）支持两种：
    - `nodeResource`：基于节点资源使用情况计算超卖量；
    - `podProfile`：基于 Pod 实例资源画像计算超卖量。
  - `oversubscription_ratio`：1~100 的整数，表示节点空闲资源超卖比百分比（例如 60 表示最多超卖"60% × 节点空闲资源量"）。
  - `oversubscription_profile_period`：Pod 画像周期，范围 60~2592000 秒。
- **推断**：Volcano 是云厂商 CCE 等平台默认的 AI/批处理调度器之一，其超卖能力面向 GPU/CPU 混部与利用率优化场景，是"算力池弹性"的关键调度机制。

### 2.3 Ray / Slurm
- **未能核实**：本次未能成功读取 Ray 与 Slurm 的相关文档。
- **推断**（公开常识，未经本次工具验证）：Ray 以分布式任务/服务化（Ray Serve）方式做推理编排；Slurm 多用于 HPC 与训练集群的作业调度，推理场景较少直接使用。

---

## 3. 算力池化/切分技术

### 3.1 MIG（Multi-Instance GPU）
- **未能核实**：本次未能成功读取 NVIDIA MIG 官方文档。
- **推断**（公开常识，未经本次工具验证）：MIG 适用于 A100/H100 等安培/霍珀架构，将物理 GPU 切分为多个隔离实例，隔离性强于时间片；消费级 GPU 不支持 MIG，通常只能走时间片。

### 3.2 时间片（已验证）
- NVIDIA 设备插件原生支持（见 2.1），是当前 K8s 生态中最易落地的 GPU 池化手段。

### 3.3 弹性伸缩
- **未能核实**：具体产品文档（如云厂商节点池自动扩缩容、抢占式实例）本次未成功读取。
- **推断**：行业通行做法是"节点池自动扩缩容 + 抢占式/竞价实例 + 推理实例副本数 HPA"，与 Volcano 超卖、设备插件时间片叠加形成多层弹性。

---

## 4. 国内算力平台

### 4.1 硅基流动 SiliconFlow（已验证）
- **已验证**（来源：siliconflow.cn 首页，本会话内成功读取）：
  - **开箱即用的大模型 API**：覆盖语言、语音、图片、视频等场景，按量计费。
  - **预留实例（Reserved Instances）**：面向企业核心推理场景，提供独占算力、精度保障与成本优化，企业级 SLA——即"独占池"形态。
  - **高效能模型推理加速服务**：自研推理引擎，宣称跨芯片、多模型适配，推理延迟最高可降低 70%、吞吐提升 3–5 倍（**厂商自述，未独立验证**）。
  - **私有化部署**方案；支持**国产异构 GPU（昇腾等）**部署。
- **推断**：硅基流动的"按量 API（共享池）+ 预留实例（独占池）+ 自研引擎 + 国产卡适配"即算力池化的一种完整商业形态，可作为本报告对标样本。

### 4.2 阿里云 PAI（未能核实）
- 尝试读取 PAI-EAS 概览页（help.aliyun.com/zh/pai/user-guide/overview-of-eas）返回 **404**，未能获取内容。
- **推断**（公开常识，未经本次工具验证）：PAI-EAS 提供弹性推理服务、多副本/多卡部署、弹性伸缩与抢占式实例等能力，需后续以官方文档核实。

### 4.3 火山引擎 / 无问芯穹（未能核实）
- 本次 web_search 无结果、页面读取失败，**未能核实**其算力池方案。
- 待补充来源：火山引擎方舟/机器学习平台文档、无问芯穹官网与产品页。

---

## 5. 已验证事实小结（可直接引用）

1. NVIDIA Kubernetes Device Plugin 原生支持 GPU 时间片（replicas 机制）+ gpu-feature-discovery 组件（NVIDIA 官方文档，已验证）。
2. Volcano 调度器支持节点级资源超卖：nodeResource / podProfile 两种超卖量计算方式，oversubscription_ratio（1~100）、oversubscription_profile_period（60~2592000 秒）等参数（华为云 CCE 官方文档，已验证）。
3. 硅基流动提供"按量大模型 API + 预留实例（独占算力、企业级 SLA）+ 自研推理引擎（宣称延迟 -70%、吞吐 3–5×）+ 私有化部署 + 昇腾等国产卡适配"（硅基流动官网首页，已验证；性能数字为厂商自述）。

## 6. 推断（未经本次工具验证，需后续核实）

- 主流开源算力池技术栈 ≈ vLLM/SGLang 推理引擎 + K8s（NVIDIA 设备插件/Volcano）+ MIG/时间片切分 + 节点弹性伸缩。
- 国产算力平台普遍兼容 vLLM 生态，并针对昇腾/寒武纪等国产卡做适配与自研引擎优化。
- MIG 与时间片的选型权衡：隔离性 vs 弹性/成本；推理场景更常用时间片+超卖，训练/高 SLA 场景更常用 MIG 或独占实例。

## 7. 未能核实清单与下一步

**未能核实**：vLLM/SGLang/TGI/TensorRT-LLM 官方文档细节；MIG 官方文档；Ray/Slurm 调度细节；阿里云 PAI-EAS、火山引擎、无问芯穹的算力池方案；各引擎性能对比数据。

**原因**：web_search 多次返回空结果；read_web_page 多次 429 限流、重定向取消、404（含阿里云 PAI 文档页）。

**下一步（最小行动）**：待搜索/页面读取服务恢复后，优先读取——vllm.readthedocs.io、docs.nvidia.com（MIG 与设备插件页）、阿里云 PAI-EAS 官方文档、火山引擎方舟文档、无问芯穹官网；随后补齐各引擎对比与国产卡适配证据。

## 8. 来源记录

| 事实 | 来源 | 验证状态 |
|---|---|---|
| NVIDIA 设备插件时间片 + GFD | NVIDIA 官方文档（本会话成功读取） | 已验证 |
| Volcano 超卖机制与参数 | 华为云 CCE 文档 cce_10_0193（本会话成功读取） | 已验证 |
| 硅基流动产品形态（API/预留实例/自研引擎/国产卡） | siliconflow.cn 首页（本会话成功读取） | 已验证（性能数字为厂商自述） |
| vLLM PagedAttention/连续批处理及性能数字 | quant67.com 文章（搜索摘要） | 片段级，未核实正文 |
| vLLM 工程完成度观点 | zdyedu.cn 博客（搜索摘要） | 片段级，观点性 |
| 阿里云 PAI-EAS 概览 | help.aliyun.com PAI 文档 | 404，未能核实 |
| SGLang/TGI/TensorRT-LLM/MIG/Ray/Slurm/火山引擎/无问芯穹 | — | 未能核实（无成功来源） |