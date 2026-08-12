import React from 'react'

export interface OutputFormatPanelProps {
  showThinking: boolean
  onShowThinkingChange: (enabled: boolean) => void
}

export function OutputFormatPanel({ showThinking, onShowThinkingChange }: OutputFormatPanelProps) {
  return (
    <label className="flex cursor-pointer items-start gap-3 border border-zinc-200 bg-white px-4 py-3.5">
      <input
        type="checkbox"
        checked={showThinking}
        onChange={(event) => onShowThinkingChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-violet-600"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-800">显示模型思考</span>
        <span className="mt-1 block text-xs leading-5 text-zinc-500">仅显示模型供应商实际返回的推理内容。模型不支持时会在发送前提示失败。</span>
      </span>
    </label>
  )
}
