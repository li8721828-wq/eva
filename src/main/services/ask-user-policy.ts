import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type { AskUserOption, AskUserRequest } from '../../shared/types/conversation'
import { IPC } from '../../shared/ipc-channels'
import { recordActivity } from './activity-log'

/** What the Agent wants on screen: one question and the options that answer it. */
export interface AskUserPrompt {
  question: string
  options: AskUserOption[]
}

export type AskUserOutcome =
  | { status: 'selected'; optionId: string; label: string }
  | { status: 'cancelled'; reason: string }

/**
 * A question is not a permission prompt: the user may legitimately take minutes.
 * The ceiling exists only so an unanswered card can never hold a runner open
 * forever after its window closes.
 */
const ASK_USER_TIMEOUT_MS = 5 * 60_000

interface PendingAskUser {
  conversationId: string
  options: AskUserOption[]
  resolve: (outcome: AskUserOutcome) => void
  timer: NodeJS.Timeout
}

const pendingAskUsers = new Map<string, PendingAskUser>()

/**
 * One card per conversation. Two tool calls in the same parallel batch would
 * otherwise overwrite the visible card and leave the sibling waiting for a click
 * that can no longer reach it.
 */
interface AskUserWaiter {
  conversationId: string
  deliver: () => void
  cancel: (reason: string) => void
}

const askUserWaiters = new Map<string, AskUserWaiter[]>()
const displayedAskUsers = new Set<string>()

function presentAskUser(waiter: AskUserWaiter): void {
  if (displayedAskUsers.has(waiter.conversationId)) {
    const waiting = askUserWaiters.get(waiter.conversationId) ?? []
    waiting.push(waiter)
    askUserWaiters.set(waiter.conversationId, waiting)
    return
  }
  displayedAskUsers.add(waiter.conversationId)
  waiter.deliver()
}

function releaseAskUserSlot(conversationId: string): void {
  const waiting = askUserWaiters.get(conversationId)
  const next = waiting?.shift()
  if (next) {
    next.deliver()
    return
  }
  if (waiting) askUserWaiters.delete(conversationId)
  displayedAskUsers.delete(conversationId)
}

function cancelAllForConversation(conversationId: string, reason: string): void {
  const waiting = askUserWaiters.get(conversationId)
  askUserWaiters.delete(conversationId)
  displayedAskUsers.delete(conversationId)
  for (const waiter of waiting ?? []) waiter.cancel(reason)
  for (const [askId, pending] of pendingAskUsers) {
    if (pending.conversationId !== conversationId) continue
    clearTimeout(pending.timer)
    pendingAskUsers.delete(askId)
    pending.resolve({ status: 'cancelled', reason })
  }
}

/** A newer request owns this conversation now: nobody is left to answer the old card. */
export function cancelAllPendingAskUsersForConversation(conversationId: string, reason: string): void {
  cancelAllForConversation(conversationId, reason)
}

export function resolvePendingAskUser(askId: string, optionId: string, conversationId: string): boolean {
  const pending = pendingAskUsers.get(askId)
  // A card belongs to the conversation that showed it: an answer arriving from
  // another chat window must not resolve this one.
  if (!pending || pending.conversationId !== conversationId) return false
  const option = pending.options.find((candidate) => candidate.id === optionId)
  if (!option) return false
  clearTimeout(pending.timer)
  pendingAskUsers.delete(askId)
  releaseAskUserSlot(pending.conversationId)
  pending.resolve({ status: 'selected', optionId: option.id, label: option.label })
  return true
}

export interface AskUserFactoryContext {
  conversationId: string
  workspaceId?: string
  /** The desktop window the stream runs through. Null when no renderer can answer. */
  window: BrowserWindow | null
}

export function createLocalAskUser(
  context: AskUserFactoryContext,
): (prompt: AskUserPrompt) => Promise<AskUserOutcome> {
  const { conversationId, workspaceId, window } = context

  return (prompt: AskUserPrompt) => {
    // Checked before anything is registered: an unanswered question must fail
    // loudly to the model instead of hanging until the timeout.
    if (!window || window.isDestroyed()) {
      return Promise.resolve({ status: 'cancelled', reason: '当前没有可回答的界面窗口' })
    }

    const askId = uuidv4()
    const payload: AskUserRequest = {
      id: askId,
      question: prompt.question,
      options: prompt.options,
      requestedAt: Date.now(),
    }

    void recordActivity({
      category: 'agent',
      action: 'chat.ask_user_requested',
      status: 'info',
      summary: `等待用户选择：${prompt.question.slice(0, 60)}`,
      conversationId,
      workspaceId,
    })

    return new Promise<AskUserOutcome>((resolve) => {
      const settle = (outcome: AskUserOutcome): void => {
        releaseAskUserSlot(conversationId)
        resolve(outcome)
      }

      const deliver = (): void => {
        const timer = setTimeout(() => {
          if (!pendingAskUsers.has(askId)) return
          pendingAskUsers.delete(askId)
          void recordActivity({
            category: 'agent',
            action: 'chat.ask_user_timeout',
            status: 'error',
            summary: `用户未在 ${Math.round(ASK_USER_TIMEOUT_MS / 60_000)} 分钟内回答该问题。`,
            conversationId,
            workspaceId,
          })
          settle({ status: 'cancelled', reason: '等待超时' })
        }, ASK_USER_TIMEOUT_MS)
        pendingAskUsers.set(askId, { conversationId, options: prompt.options, resolve: settle, timer })

        if (window.isDestroyed()) {
          clearTimeout(timer)
          pendingAskUsers.delete(askId)
          settle({ status: 'cancelled', reason: '界面窗口已关闭' })
          return
        }
        window.webContents.send(IPC.CHAT_STREAM, {
          conversationId,
          type: 'ask_user_request',
          askUser: payload,
        })
      }

      presentAskUser({
        conversationId,
        deliver,
        cancel: (reason) => resolve({ status: 'cancelled', reason }),
      })
    })
  }
}
