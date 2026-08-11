import type { LLMProvider } from '../providers/base-provider'
import { getStorage } from '../storage'
import type { Conversation } from '../../shared/types/conversation'
import { recordActivity } from './activity-log'

const inFlightTitles = new Set<string>()

function wasGeneratedFromFirstMessage(title: string, message: string): boolean {
  const normalized = message.replace(/\s+/g, ' ').trim()
  const legacyTitle = normalized.length > 36 ? `${normalized.slice(0, 36)}...` : normalized
  return title === 'New Conversation' || title === '新建任务对话' || title === legacyTitle
}

function canGenerateTitle(conversation: Conversation, firstMessage: string): boolean {
  if (conversation.titleSource === 'manual' || conversation.titleSource === 'system') return false
  // A completed model title is no longer equal to the placeholder or legacy
  // first-message title, so it naturally becomes ineligible for retries.
  return wasGeneratedFromFirstMessage(conversation.title, firstMessage)
}

function parseTitle(content: string): string | null {
  const candidate = content.trim()
  if (!candidate || /[\r\n]/.test(candidate) || /["'`“”‘’，。.!！?？:：#*_]/.test(candidate)) return null
  const length = Array.from(candidate).length
  return length >= 6 && length <= 9 ? candidate : null
}

const TITLE_RULES = '你是会话标题生成器。根据用户首条任务生成一个中文任务标题。必须且只能输出一个 6 到 9 个字符的标题；不得输出引号、标点、冒号、解释、Markdown 或换行。标题要概括实际要做的事，不要使用“任务”“对话”“处理”等空泛词。'

async function requestTitle(provider: LLMProvider, model: string, firstMessage: string, previousResponse?: string): Promise<string> {
  const correction = previousResponse
    ? `\n\n上一次输出不符合格式：${previousResponse}\n请严格按照规则重新生成。`
    : ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await provider.chatComplete({
      model,
      temperature: 0,
      // Reasoning models can spend a small output budget before producing the
      // visible answer. Leave enough room for the required title itself.
      maxTokens: 512,
      messages: [
        { role: 'system', content: TITLE_RULES },
        { role: 'user', content: `用户首条任务：${firstMessage}${correction}` },
      ],
    }, controller.signal)
    return response.content
  } finally {
    clearTimeout(timeout)
  }
}

export async function generateConversationTitle(input: {
  conversationId: string
  firstMessage: string
  provider: LLMProvider
  model: string
  notify?: (conversationId: string) => void
}): Promise<void> {
  if (inFlightTitles.has(input.conversationId)) return
  inFlightTitles.add(input.conversationId)

  try {
    const conversation = await getStorage().conversations.getConversation(input.conversationId)
    if (!conversation || !canGenerateTitle(conversation, input.firstMessage)) return

    const initialResponse = await requestTitle(input.provider, input.model, input.firstMessage)
    const retryResponse = parseTitle(initialResponse)
      ? undefined
      : await requestTitle(input.provider, input.model, input.firstMessage, initialResponse)
    const title = parseTitle(initialResponse) || parseTitle(retryResponse || '')
    if (!title) {
      void recordActivity({
        category: 'conversation',
        action: 'conversation.title.generation_failed',
        status: 'error',
        summary: `Model did not return a 6-9 character title: ${JSON.stringify((retryResponse || initialResponse).slice(0, 80))}`,
        conversationId: input.conversationId,
      })
      return
    }

    const latest = await getStorage().conversations.getConversation(input.conversationId)
    if (!latest || !canGenerateTitle(latest, input.firstMessage)) return
    await getStorage().conversations.updateConversation(input.conversationId, { title, titleSource: 'auto' })
    void recordActivity({
      category: 'conversation',
      action: 'conversation.title.generated',
      status: 'success',
      summary: `Generated task title: ${title}`,
      conversationId: input.conversationId,
    })
    input.notify?.(input.conversationId)
  } catch (error) {
    void recordActivity({
      category: 'conversation',
      action: 'conversation.title.generation_failed',
      status: 'error',
      summary: `Could not generate task title: ${error instanceof Error ? error.message : 'unknown error'}`,
      conversationId: input.conversationId,
    })
    // A title is auxiliary metadata. Model or network failures must not affect chat.
  } finally {
    inFlightTitles.delete(input.conversationId)
  }
}

export async function refreshLegacyConversationTitles(input: {
  provider: LLMProvider
  model: string
  notify?: (conversationId: string) => void
}): Promise<void> {
  const conversations = await getStorage().conversations.listConversations()
  for (const conversation of conversations) {
    if (conversation.titleSource === 'manual' || conversation.titleSource === 'system') continue
    const messages = await getStorage().conversations.getMessages(conversation.id)
    const firstUserMessage = messages.find((message) => message.role === 'user')
    if (!firstUserMessage || !canGenerateTitle(conversation, firstUserMessage.content)) continue
    await generateConversationTitle({
      conversationId: conversation.id,
      firstMessage: firstUserMessage.content,
      provider: input.provider,
      model: input.model,
      notify: input.notify,
    })
  }
}
