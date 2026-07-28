import React, { useState } from 'react'
import { useTaskStore } from '@/stores/use-task-store'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useChatStore } from '@/stores/use-chat-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { Input } from '@/components/ui/Input'
import { Target, Play, ChevronDown, ChevronUp } from 'lucide-react'

export interface GoalInputProps {
  className?: string
}

export function GoalInput({ className }: GoalInputProps) {
  const { startGoal } = useTaskStore()
  const { workspacePath } = useAppStore()
  const { agents, selectedAgentId } = useAgentStore()
  const { conversations, currentConversationId } = useChatStore()

  const [goal, setGoal] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [maxSteps, setMaxSteps] = useState('15')
  const [timeout, setTimeout_] = useState('10')

  const currentConversation = conversations.find((c) => c.id === currentConversationId)
  const agentId = selectedAgentId || currentConversation?.agentId || agents[0]?.id || ''
  const conversationId = currentConversationId || ''

  const handleStart = () => {
    if (!goal.trim()) return
    startGoal(goal.trim(), agentId, conversationId, {
      maxSteps: parseInt(maxSteps) || 15,
      timeout: (parseInt(timeout) || 10) * 60 * 1000,
      autoAdjust: true,
    })
    setGoal('')
  }

  return (
    <div className={cn('flex flex-col gap-4 p-4', className)}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <Target className="h-5 w-5 text-violet-500" />
        <h2 className="text-base font-medium text-zinc-800">Goal Mode</h2>
      </div>
      <p className="text-sm text-zinc-500">
        Describe a goal and the agent will plan and execute it step by step.
      </p>

      {/* Goal input */}
      <Textarea
        placeholder="Describe what you want to accomplish..."
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        className="resize-none min-h-[120px] text-sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            handleStart()
          }
        }}
      />

      {/* Advanced options toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-400 transition-colors"
      >
        {showAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        Advanced Options
      </button>

      {showAdvanced && (
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-sm font-medium text-zinc-500 block mb-1.5">Max Steps</label>
            <Input
              type="number"
              min={1}
              max={30}
              value={maxSteps}
              onChange={(e) => setMaxSteps(e.target.value)}
              className="text-sm"
            />
          </div>
          <div className="flex-1">
            <label className="text-sm font-medium text-zinc-500 block mb-1.5">Timeout (min)</label>
            <Input
              type="number"
              min={1}
              max={60}
              value={timeout}
              onChange={(e) => setTimeout_(e.target.value)}
              className="text-sm"
            />
          </div>
        </div>
      )}

      {/* Start button */}
      <div className="flex items-center gap-2">
        <Button
          className="flex-1 gap-1.5 bg-violet-600 hover:bg-violet-700"
          onClick={handleStart}
          disabled={!goal.trim()}
        >
          <Play className="h-4 w-4" />
          Start Goal Execution
        </Button>
      </div>
      <p className="text-xs text-zinc-400">Ctrl+Enter to start</p>
    </div>
  )
}
