/** Semantic aliases for permissions and presentation; never rename native tool events. */
export const NATIVE_TOOL_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    read: 'read_file',
    read_image: 'read_file',
    write: 'write_file',
    edit: 'edit_file',
    ls: 'list_directory',
    bash: 'execute_command',
    powershell: 'execute_command',
    pwsh: 'execute_command',
    todo_write: 'create_execution_plan',
    create_goal: 'run_goal',
    get_goal: 'manage_goal',
    update_goal: 'manage_goal',
  })

export function canonicalToolName(name: string): string {
  return Object.hasOwn(NATIVE_TOOL_ALIASES, name)
    ? NATIVE_TOOL_ALIASES[name]
    : name
}

export function toolTargetPath(
  args: Record<string, unknown>,
): string | undefined {
  const value = args.path ?? args.file_path
  return typeof value === 'string' ? value : undefined
}

export function toolImplementationLabel(
  data?: Record<string, unknown>,
): string | undefined {
  if (data?.nativeTool === true && data.executionEngine === 'pi')
    return 'Pi 原生'
  if (data?.nativeTool === true && data.executionEngine === 'deepseek-harness')
    return 'Harness 原生'
  if (data?.toolImplementation === 'eva-extension') return 'Eva 扩展'
  return undefined
}
