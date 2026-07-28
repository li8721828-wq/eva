export const IPC = {
  // 会话管理
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_LOAD: 'conversation:load',
  CONVERSATION_UPDATE: 'conversation:update',
  CONVERSATION_CHANGED: 'conversation:changed',

  // Activity log
  ACTIVITY_LIST: 'activity:list',
  ACTIVITY_STREAM: 'activity:stream',

  // Workspace management
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',

  // Plugin management
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_MARKETPLACE: 'plugin:marketplace',
  PLUGIN_INSTALL_MARKETPLACE: 'plugin:install-marketplace',
  PLUGIN_IMPORT: 'plugin:import',
  PLUGIN_TOGGLE: 'plugin:toggle',
  PLUGIN_DELETE: 'plugin:delete',
  PLUGIN_UPDATE_SETTINGS: 'plugin:update-settings',
  PLUGIN_SELECT_PATH: 'plugin:select-path',

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

  // QQ remote control
  QQ_REMOTE_GET_CONFIG: 'qq-remote:get-config',
  QQ_REMOTE_SAVE_CONFIG: 'qq-remote:save-config',
  QQ_REMOTE_GET_STATUS: 'qq-remote:get-status',
  QQ_REMOTE_CONNECT: 'qq-remote:connect',
  QQ_REMOTE_DISCONNECT: 'qq-remote:disconnect',
} as const
