/**
 * A conversation's primary terminal has a stable ID so the visible panel and
 * its Agent always address the same shell process.
 */
export function conversationTerminalSessionId(conversationId: string): string {
  return `conversation-terminal-${conversationId}`
}
