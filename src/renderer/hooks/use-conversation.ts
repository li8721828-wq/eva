import { useEffect } from 'react'
import { useChatStore } from '@/stores/use-chat-store'

/**
 * Hook that provides conversation list and operations.
 * Auto-loads conversations on mount.
 */
export function useConversations() {
  const {
    conversations,
    currentConversationId,
    loadConversations,
    createConversation,
    selectConversation,
    deleteConversation,
  } = useChatStore()

  // Load conversations on mount
  useEffect(() => {
    loadConversations()
  }, [])

  return {
    conversations,
    currentConversationId,
    createConversation,
    selectConversation,
    deleteConversation,
    refreshConversations: loadConversations,
  }
}
