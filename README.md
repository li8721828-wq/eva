# Eva - AI Coding Agent Desktop Client

Eva 是一个基于 Electron 的桌面端 AI 编程助手，支持多 AI Agent 协作，帮助你高效完成编码任务。

## ✨ 功能特性

- **多 Agent 协作** — 支持 Leader、Researcher、Coder、Reviewer、Tester 等多种角色，通过团队编排实现复杂任务分工
- **多 Provider 支持** — 兼容 OpenAI 和 Anthropic Claude 等主流 AI 提供商
- **目标驱动模式** — 设定高层目标，Agent 自动规划并分解任务
- **内置代码编辑器** — 集成 Monaco Editor，提供接近 VS Code 的编辑体验
- **内置终端** — 使用 xterm.js 实现命令行操作
- **任务看板** — 可视化追踪任务进度和状态
- **对话式交互** — 支持 Markdown 渲染、代码高亮，实时流式输出
- **跨平台** — 支持 Windows、macOS、Linux

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | Electron + React + TypeScript |
| 构建工具 | electron-vite + Vite |
| 状态管理 | Zustand |
| UI 样式 | Tailwind CSS + Lucide React |
| 代码编辑器 | Monaco Editor |
| 终端模拟 | xterm.js + node-pty |
| AI SDK | OpenAI / Anthropic SDK |
| 测试 | Vitest |
| 打包 | electron-builder |

## 📁 项目结构

```
eva/
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── agent-engine/      # Agent 引擎（运行器、上下文、目标规划、团队编排）
│   │   ├── ipc/               # IPC 通信处理
│   │   ├── providers/         # AI 提供商适配（OpenAI / Anthropic）
│   │   ├── services/          # 核心服务（文件、终端、规格）
│   │   ├── storage/           # 持久化存储
│   │   ├── tools/             # Agent 工具注册
│   │   └── utils/             # 工具函数
│   ├── preload/               # 预加载脚本
│   ├── renderer/              # 渲染进程（React UI）
│   │   ├── components/        # UI 组件
│   │   ├── hooks/             # React Hooks
│   │   ├── stores/            # 状态管理
│   │   └── lib/               # 工具库
│   └── shared/                # 共享类型和常量
│       ├── types/             # TypeScript 类型定义
│       └── ipc-channels.ts    # IPC 通道常量
└── tests/                     # 单元测试
```

## 🚀 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建

```bash
# 构建当前平台
npm run build

# 打包 Windows 安装包
npm run build:win

# 打包 macOS 安装包
npm run build:mac

# 打包 Linux 安装包
npm run build:linux
```

### 运行测试

```bash
npm test
```

## 🔧 配置

启动应用后，在设置页面配置 AI 提供商：

1. 点击侧边栏的**设置**按钮
2. 选择 AI 提供商（OpenAI / Anthropic）
3. 填入 **API Key** 和可选的 **Base URL**
4. 保存并启用

## 📄 License

MIT
