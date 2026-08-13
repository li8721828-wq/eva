import type { WorkMode } from '../../../shared/types'
import { useAppStore } from '@/stores/use-app-store'
import { cn } from '@/lib/utils'
import { Select } from '@/components/ui/Select'

const modes: { value: WorkMode; label: string; description: string }[] = [
  {
    value: 'normal',
    label: 'Auto',
    description: 'Use a team automatically for complex tasks',
  },
  {
    value: 'expert',
    label: 'Team (smart)',
    description: 'Use a team only when the request benefits from collaboration',
  },
]

export interface ModeSelectorProps {
  className?: string
}

export function ModeSelector({ className }: ModeSelectorProps) {
  const { workMode, setWorkMode } = useAppStore()
  const currentMode = modes.find((mode) => mode.value === workMode)

  return (
    <Select
      value={workMode}
      onChange={(event) => setWorkMode(event.target.value as WorkMode)}
      options={modes.map((mode) => ({ value: mode.value, label: mode.label }))}
      className={cn('h-9 rounded-md border border-transparent bg-transparent text-sm font-medium text-zinc-700 shadow-none hover:border-indigo-100/70 hover:bg-white/30 hover:text-indigo-900 focus:border-indigo-100/80 focus:bg-white/38 focus:shadow-none focus:ring-0 focus-visible:border-indigo-100/80 focus-visible:ring-0', className)}
      aria-label="Select work mode"
      title={currentMode?.description}
    />
  )
}
