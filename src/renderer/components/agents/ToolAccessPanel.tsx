import { Boxes, Globe2, HardDrive, Search, TerminalSquare } from 'lucide-react'
import { TOOL_CATALOG, type ToolCatalogEntry } from '../../../shared/tool-catalog'
import { cn } from '@/lib/utils'

const categoryIcons = {
  Files: HardDrive,
  Search,
  Execution: TerminalSquare,
  Internet: Globe2,
  Integrations: Boxes,
}

const riskStyles: Record<ToolCatalogEntry['risk'], string> = {
  read: 'bg-sky-50 text-sky-700',
  write: 'bg-amber-50 text-amber-700',
  system: 'bg-rose-50 text-rose-700',
  network: 'bg-violet-50 text-violet-700',
}

const riskLabels: Record<ToolCatalogEntry['risk'], string> = {
  read: 'Read',
  write: 'Write',
  system: 'System',
  network: 'Network',
}

export interface ToolAccessPanelProps {
  tools: string[]
  onChange: (tools: string[]) => void
  disabled?: boolean
}

export function ToolAccessPanel({ tools, onChange, disabled = false }: ToolAccessPanelProps) {
  const toggle = (toolId: string) => {
    if (disabled) return
    onChange(tools.includes(toolId) ? tools.filter((tool) => tool !== toolId) : [...tools, toolId])
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-800">Tool access</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">Assign only the capabilities this agent needs. Network tools can access public internet content.</p>
        </div>
        <span className="shrink-0 text-xs text-zinc-400">{tools.length} enabled</span>
      </div>

      {Object.entries(categoryIcons).map(([category, Icon]) => {
        const entries = TOOL_CATALOG.filter((tool) => tool.category === category)
        return (
          <section key={category} className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <Icon className="h-3.5 w-3.5" />
              {category}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {entries.map((tool) => {
                const enabled = tools.includes(tool.id)
                return (
                  <label
                    key={tool.id}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-3 transition-colors',
                      enabled ? 'border-violet-300 bg-violet-50/70' : 'border-zinc-200 bg-white hover:border-zinc-300',
                      disabled && 'cursor-default opacity-60'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={disabled}
                      onChange={() => toggle(tool.id)}
                      className="mt-0.5 h-4 w-4 accent-violet-600"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                        {tool.label}
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', riskStyles[tool.risk])}>{riskLabels[tool.risk]}</span>
                      </span>
                      <span className="mt-1 block text-xs leading-4 text-zinc-500">{tool.description}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
