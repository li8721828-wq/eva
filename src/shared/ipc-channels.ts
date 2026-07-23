export const IPC = {
  // 会话管理
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_LOAD: 'conversation:load',
  CONVERSATION_UPDATE: 'conversation:update',

  // Workspace management
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',

  // 聊天（流式）
  CHAT_SEND: 'chat:send',
  CHAT_STREAM: 'chat:stream',
  CHAT_ABORT: 'chat:abort',

  // 智能体管理
  AGENT_LIST: 'agent:list',
  AGENT_GET: 'agent:get',
  AGENT_CREATE: 'agent:create',
  AGENT_UPDATE: 'agent:update',
  AGENT_DELETE: 'agent:delete',

  // 任务（Goal/Expert 模式）
  TASK_START: 'task:start',
  TASK_STREAM: 'task:stream',
  TASK_ABORT: 'task:abort',
  TASK_STATUS: 'task:status',
  TASK_GOAL_START: 'task:goal:start',
  TASK_GOAL_STREAM: 'task:goal:stream',
  TASK_GOAL_ABORT: 'task:goal:abort',
  TASK_GOAL_PAUSE: 'task:goal:pause',
  TASK_GOAL_RESUME: 'task:goal:resume',

  // Spec 模板
  SPEC_LIST: 'spec:list',
  SPEC_GET: 'spec:get',

  // 文件系统
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  FILE_TREE: 'file:tree',
  FILE_SEARCH: 'file:search',
  FILE_SELECT_FOLDER: 'file:select-folder',

  // 终端
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DESTROY: 'terminal:destroy',
  MENU_TOGGLE_TERMINAL: 'menu:toggle-terminal',

  // 配置
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_ALL: 'config:get-all',
  PROVIDER_LIST: 'provider:list',
  PROVIDER_CONFIG: 'provider:config',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_MODELS: 'provider:models',
} as const
