import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogClose } from '@/components/ui/Dialog'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Terminal } from '@xterm/xterm'
import { terminalTheme } from '@/lib/terminal-theme'
import '@/index.css'
import '@xterm/xterm/css/xterm.css'

const options = [
  { value: 'chat', label: '对话 · 当前智能体直接处理' },
  { value: 'disabled', label: '不可用连接', disabled: true },
  { value: 'team', label: '团队协作 · 按需分派任务' },
]
function Fixture() {
  const [open, setOpen] = useState(false)
  const [nested, setNested] = useState(false)
  const [value, setValue] = useState('chat')
  return (
    <div className="eva-app-shell h-screen p-8 text-zinc-900">
      <div className="settings-page max-w-3xl space-y-6">
        <header>
          <h1 className="text-lg font-semibold">Eva · 交互与主题检查</h1>
          <p className="text-sm text-zinc-500">对话画布 / 任务工作区 / 模型连接</p>
        </header>
        <section className="eva-panel eva-lift space-y-3 p-5">
          <h2 className="text-base font-semibold">模型连接</h2>
          <p className="settings-help text-xs">选择本次对话使用的连接，设置保存失败时可重试。</p>
          <Input id="outside-input" aria-label="连接名称" defaultValue="日常开发" />
          <Button id="open-dialog" onClick={() => setOpen(true)}>
            编辑连接
          </Button>
        </section>
        <div className="chat-composer rounded-lg bg-white p-4 shadow-float">
          <div className="relative">
            <div
              id="highlight"
              className="chat-composer__highlight pointer-events-none absolute inset-0 whitespace-pre-wrap py-1.5"
            >
              <span className="text-violet-600">/coding</span> 帮我检查这个项目
            </div>
            <textarea
              id="composer"
              aria-label="消息"
              className="chat-composer__textarea w-full resize-none bg-transparent py-1.5 text-transparent caret-zinc-900"
              defaultValue="/coding 帮我检查这个项目"
            />
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-zinc-100 pt-3">
            <div className="w-64">
              <Select
                id="standalone-select"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                options={options}
                aria-label="工作模式"
              />
            </div>
            <span className="text-xs text-zinc-500">文件权限</span>
          </div>
        </div>
        <div id="terminal" className="eva-terminal h-32 rounded-lg p-3" />
      </div>
      <div className="fixed bottom-2 right-2">
        <Select
          id="edge-select"
          className="w-8"
          menuWidth={400}
          value={value}
          options={options}
          aria-label="边缘菜单"
        />
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogHeader>
          <DialogTitle>编辑模型连接</DialogTitle>
          <DialogDescription>菜单与弹窗共享按键和焦点规则。</DialogDescription>
        </DialogHeader>
        <DialogClose onClose={() => setOpen(false)} />
        <div className="space-y-4">
          <Input id="dialog-input" aria-label="名称" defaultValue="开发助手" />
          <Select
            id="dialog-select"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            options={options}
            aria-label="选择工作模式"
          />
          <Button id="nested-dialog" onClick={() => setNested(true)}>
            更多设置
          </Button>
          <Button id="save-dialog" onClick={() => setOpen(false)}>
            保存
          </Button>
        </div>
        <Dialog open={nested} onOpenChange={setNested}>
          <DialogTitle>更多设置</DialogTitle>
          <Button id="close-nested" onClick={() => setNested(false)}>
            返回
          </Button>
        </Dialog>
      </Dialog>
    </div>
  )
}
if (new URLSearchParams(location.search).get('page') === 'workspace') {
  void import('./workspace-fixture')
} else if (new URLSearchParams(location.search).get('page') === 'purposes') {
  void import('./purpose-fixture')
} else if (new URLSearchParams(location.search).get('page') === 'settings') {
  void import('./settings-fixture')
} else {
  createRoot(document.getElementById('root')!).render(<Fixture />)
  const terminal = new Terminal({ theme: terminalTheme('light'), rows: 3, cols: 80, fontSize: 12 })
  setTimeout(() => {
    terminal.open(document.getElementById('terminal')!)
    terminal.write('PS D:\\Projects\\Eva> npm run typecheck\r\n\x1b[32m检查通过\x1b[0m  ·  Ready\r\n')
    ;(window as any).setTestTheme = (theme: 'light' | 'dark' | 'starlight') => {
      document.documentElement.dataset.theme = theme
      terminal.options.theme = terminalTheme(theme)
    }
    ;(window as any).uiReady = true
  }, 0)
}
