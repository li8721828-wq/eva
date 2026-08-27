/** Declarative command catalogue shared by the chat input and command menu. */
export const CHAT_SLASH_COMMANDS = [
  { command: 'requirement', label: '/requirement', description: '开始需求分析、代码分析、澄清与评测' },
  { command: 'requirement-modeling', label: '/requirement-modeling', description: '将已明确需求建模为标准化规格与验收文档' },
  { command: 'spec', label: '/spec', description: '基于需求建模和代码证据构建并校验实施规格' },
  { command: 'dsl', label: '/dsl', description: 'Use the completed specification to generate domain-language DSL files' },
  { command: 'coding', label: '/coding', description: 'Generate and verify isolated Java code from the persisted DSL without AI' },
  { command: 'file', label: '/file', description: '添加一个或多个文件到当前消息' },
  { command: 'folder', label: '/folder', description: '添加一个文件夹到当前消息' },
] as const

export type ChatSlashCommand = typeof CHAT_SLASH_COMMANDS[number]['command']

export function activeSlashCommand(input: string, isSymposium: boolean): string | null {
  const match = input.match(/^\/([a-z-]*)$/i)
  return !isSymposium && match ? match[1].toLowerCase() : null
}
