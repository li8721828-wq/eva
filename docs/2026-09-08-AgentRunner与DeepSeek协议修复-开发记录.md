# AgentRunner 与 DeepSeek 协议修复开发记录

日期：2026-09-08  
版本：0.1.190

## 变更范围

本次修改集中在 AgentRunner、OpenAI 兼容 Provider、上下文转换和回归测试，不改变工具执行器本身的权限模型。

## AgentRunner 链路

### 工具阶段

`executeLLMCall()` 继续接收结构化工具定义，并按原生 `tool_calls` 执行工具。每次完成工具后，`appendToolMessages()` 会写入：

- assistant tool-call 消息；
- 与每个 call ID 对应的 tool result；
- 本轮模型产生的 `reasoningContent`。

这样可以满足 DeepSeek 思考模式在后续工具轮次中回传推理内容的要求，同时保持 OpenAI 兼容 API 的消息配对完整。

### 最终汇总阶段

新增 `buildFinalSynthesisMessages()`：

1. 保留 system、user 和普通 assistant 消息；
2. 移除 assistant tool-call 与 tool 消息对；
3. 将工具结果按工具名称压缩为一个有上限的权威证据块；
4. 以无工具的 user 消息交给最终汇总模型。

该处理避免网关在“带工具协议上下文”切换到“tools=undefined”时返回空消息，也减少了最终汇总的输入体积。

## Provider 层变更

`ChatMessageInput` 新增可选 `reasoningContent`。`toOpenAIMessages()` 在 assistant 消息存在该字段时映射为 `reasoning_content`。非 DeepSeek 网关通常会忽略该可选字段，DeepSeek 思考模式则可以继续使用。

AgentRunner 的输出预算从固定 2048 调整为：

| 路由能力 | 单次 max tokens |
| --- | ---: |
| 普通模型 | 4096 |
| 支持思考的模型 | 8192 |

该额度仍包含供应商可能计入的推理 token，因此不是对最终可见文本长度的硬保证。

## 空汇总处理策略

当工具已完成、最终汇总返回 `stop` 但 `content` 为空时：

- 不重跑工具；
- 使用已有证据构造纯文本恢复请求；
- 最多执行两次恢复尝试；
- 恢复仍失败才报告空回复错误。

当返回的是 DSML/XML 等未执行协议文本时，仍按协议错误处理，不会把错误文本标记为成功，也不会执行未经解析和校验的调用。

## 测试与兼容性

新增/更新测试覆盖：

- DeepSeek assistant `reasoning_content` 回传；
- 工具完成后的空汇总恢复；
- 最终汇总上下文不含原生工具交易；
- 思考模型输出预算变化。

当前完整测试结果为 324/324 通过，生产构建通过。现有 `streamdown` 的 `use client` 构建提示仍是依赖包警告，与本次修复无关。

## 后续观测指标

建议在真实环境继续观察：

- 空汇总首次出现率与恢复成功率；
- DeepSeek 思考 token 占比；
- 最终汇总请求的输入 token 与耗时；
- 同一 provider/model 是否仍出现连续空流。

若同一连接连续出现空流，应优先检查网关实际上游、模型 ID、思考模式参数和账号额度，而不是继续增加重试次数。
