import React from 'react'
import type { WorkMode } from '../../../shared/types'
import { useAppStore } from '@/stores/use-app-store'
import { cn } from '@/lib/utils'
import { Code2, Users, Target } from 'lucide-react'

const modes: { value: WorkMode; label: string; description: string; icon: React.ReactNode }[] = [
  {
    value: 'normal',
    label: 'Normal',
    description: 'Single agent coding',
    icon: <Code2 className="h-4 w-4" />,
  },
  {
    value: 'expert',
    label: 'Expert Team',
    description: 'Multi-agent collaboration',
    icon: <Users className="h-4 w-4" />,
  },
  {
    value: 'goal',
    label: 'Goal',
    description: 'Goal-driven automation',
    icon: <Target className="h-4 w-4" />,
  },
]

export interface ModeSelectorProps {
  className?: string
}

export function ModeSelector({ className }: ModeSelectorProps) {
  const { workMode, setWorkMode } = useAppStore()

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {modes.map((mode) => (
        <button
          key={mode.value}
          onClick={() => setWorkMode(mode.value)}
          className={cn(
            'flex min-h-14 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-all duration-200',
            workMode === mode.value
              ? 'bg-violet-100 text-violet-700'
              : 'text-zinc-600 hover:bg-zinc-200 hover:text-zinc-800'
          )}
        >
          <span className={cn(workMode === mode.value ? 'text-violet-600' : 'text-zinc-400')}>
            {mode.icon}
          </span>
          <div className="flex flex-col">
            <span className="font-medium">{mode.label}</span>
            <span className="text-xs text-zinc-500">{mode.description}</span>
          </div>
        </button>
      ))}
    </div>
  )
}
