export const IPC = {
  // 会话管理
  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_LOAD: 'conversation:load',
  CONVERSATION_UPDATE: 'conversation:update',
  CONVERSATION_MESSAGE_UPDATE: 'conversation:message-update',
  CONVERSATION_MESSAGES_DELETE_FROM: 'conversation:messages-delete-from',
  CONVERSATION_CHANGED: 'conversation:changed',

  // Activity log
  ACTIVITY_LIST: 'activity:list',
  ACTIVITY_STREAM: 'activity:stream',

  // Workspace management
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',
  PROJECT_INDEX_STATUS: 'project-index:status',
  PROJECT_INDEX_SEARCH: 'project-index:search',
  PROJECT_INDEX_BROWSE: 'project-index:browse',
  PROJECT_INDEX_REFRESH: 'project-index:refresh',

  // Per-conversation Git worktrees
  GIT_STATUS: 'git:status',
  GIT_SWITCH_BRANCH: 'git:switch-branch',

  // Plugin management
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_MARKETPLACE: 'plugin:marketplace',
  PLUGIN_INSTALL_MARKETPLACE: 'plugin:install-marketplace',
  PLUGIN_IMPORT: 'plugin:import',
  PLUGIN_TOGGLE: 'plugin:toggle',
  PLUGIN_DELETE: 'plugin:delete',
  PLUGIN_UPDATE_SETTINGS: 'plugin:update-settings',
  PLUGIN_SELECT_PATH: 'plugin:select-path',
  PLUGIN_LOCAL_SEARXNG_STATUS: 'plugin:local-searxng-status',
  PLUGIN_LOCAL_SEARXNG_INSTALL: 'plugin:local-searxng-install',
  PLUGIN_LOCAL_SEARXNG_STOP: 'plugin:local-searxng-stop',

  // 聊天（流式）
  CHAT_SEND: 'chat:send',
  CHAT_STREAM: 'chat:stream',
  CHAT_ABORT: 'chat:abort',

  // Shared multi-agent discussion
  SYMPOSIUM_START: 'symposium:start',
  SYMPOSIUM_CONTINUE: 'symposium:continue',
  SYMPOSIUM_ABORT: 'symposium:abort',
  SYMPOSIUM_STREAM: 'symposium:stream',

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
  TASK_CANCEL: 'task:cancel',
  TASK_STATUS: 'task:status',
  TASK_SNAPSHOT: 'task:snapshot',
  TASK_ARTIFACTS_LIST: 'task:artifacts:list',
  TASK_FEEDBACK_ADD: 'task:feedback:add',
  TASK_CHECKPOINT_RESUME: 'task:checkpoint:resume',
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
  FILE_SELECT_ATTACHMENTS: 'file:select-attachments',
  FILE_IMAGE_PREVIEW: 'file:image-preview',
  FILE_SAVE_CLIPBOARD_IMAGE: 'file:save-clipboard-image',

  // 终端
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DESTROY: 'terminal:destroy',
  MENU_TOGGLE_TERMINAL: 'menu:toggle-terminal',

  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_GET_VERSION: 'window:get-version',

  // 配置
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_ALL: 'config:get-all',
  PROVIDER_LIST: 'provider:list',
  PROVIDER_CONFIG: 'provider:config',
  PROVIDER_DELETE: 'provider:delete',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_MODELS: 'provider:models',
  MODEL_POOL_LIST: 'model-pool:list',
  MODEL_POOL_SAVE: 'model-pool:save',
  MODEL_POOL_ROUTE: 'model-pool:route',
  COST_USAGE_REPORT: 'cost:usage-report',
  COST_RATE_CARDS_SAVE: 'cost:rate-cards-save',

  // QQ remote control
  QQ_REMOTE_GET_CONFIG: 'qq-remote:get-config',
  QQ_REMOTE_SAVE_CONFIG: 'qq-remote:save-config',
  QQ_REMOTE_GET_STATUS: 'qq-remote:get-status',
  QQ_REMOTE_CONNECT: 'qq-remote:connect',
  QQ_REMOTE_DISCONNECT: 'qq-remote:disconnect',
} as const
