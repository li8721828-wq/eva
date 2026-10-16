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

export interface SlashPopoverItem {
  kind: 'command' | 'skill'
  /** Token typed after `/`. */
  name: string
  /** Text shown in the row. */
  label: string
  description: string
}

/** Skills are named with `[a-z0-9._-]`, so the trigger token must accept dots and underscores. */
export function activeSlashCommand(input: string, isSymposium: boolean): string | null {
  const match = input.match(/^\/([a-z0-9._-]*)$/i)
  return !isSymposium && match ? match[1].toLowerCase() : null
}

/**
 * One flat list keeps the existing single-index keyboard model: commands first, then
 * skills. A skill that shares a command's name stays listed — the group header and the
 * row's own kind tell them apart, and hiding an installed skill would be worse.
 */
export function buildSlashPopoverItems(
  query: string,
  skills: ReadonlyArray<{ name: string; description: string }>,
): SlashPopoverItem[] {
  const commands: SlashPopoverItem[] = CHAT_SLASH_COMMANDS
    .filter((item) => item.command.startsWith(query))
    .map((item) => ({ kind: 'command', name: item.command, label: item.label, description: item.description }))
  const skillItems: SlashPopoverItem[] = skills
    .filter((skill) => skill.name.toLowerCase().startsWith(query))
    .map((skill) => ({ kind: 'skill', name: skill.name, label: `/${skill.name}`, description: skill.description }))
  return [...commands, ...skillItems]
}
