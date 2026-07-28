import React, { useEffect, useState, useMemo } from 'react'
import type { SpecTemplate } from '../../../shared/types/spec'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SpecParameterForm } from './SpecParameterForm'
import { cn } from '@/lib/utils'
import {
  Search,
  RefreshCw,
  Bug,
  PlusCircle,
  Eye,
  ChevronRight,
  ArrowLeft,
  ListChecks,
  Code2,
  Users,
  Target,
} from 'lucide-react'

export interface SpecSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectTemplate: (template: SpecTemplate, params: Record<string, string>) => void
}

const CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'refactor', label: 'Refactor' },
  { value: 'bugfix', label: 'Bugfix' },
  { value: 'feature', label: 'Feature' },
  { value: 'review', label: 'Review' },
]

const ICON_MAP: Record<string, React.ReactNode> = {
  'refresh-cw': <RefreshCw className="h-5 w-5" />,
  bug: <Bug className="h-5 w-5" />,
  'plus-circle': <PlusCircle className="h-5 w-5" />,
  eye: <Eye className="h-5 w-5" />,
}

const MODE_BADGE: Record<string, { label: string; variant: 'primary' | 'success' | 'warning' }> = {
  normal: { label: 'Normal', variant: 'primary' },
  expert: { label: 'Expert Team', variant: 'warning' },
  goal: { label: 'Goal Mode', variant: 'success' },
}

const MODE_ICON: Record<string, React.ReactNode> = {
  normal: <Code2 className="h-3 w-3" />,
  expert: <Users className="h-3 w-3" />,
  goal: <Target className="h-3 w-3" />,
}

export function SpecSelector({ open, onOpenChange, onSelectTemplate }: SpecSelectorProps) {
  const [templates, setTemplates] = useState<SpecTemplate[]>([])
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState<SpecTemplate | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setLoading(true)
      setSelectedTemplate(null)
      setShowDetail(false)
      setSearchQuery('')
      setSelectedCategory('all')
      window.eva.spec
        .list()
        .then(setTemplates)
        .catch(console.error)
        .finally(() => setLoading(false))
    }
  }, [open])

  const filteredTemplates = useMemo(() => {
    return templates.filter((t) => {
      const matchCategory = selectedCategory === 'all' || t.category === selectedCategory
      const matchSearch =
        !searchQuery ||
        t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.description.toLowerCase().includes(searchQuery.toLowerCase())
      return matchCategory && matchSearch
    })
  }, [templates, selectedCategory, searchQuery])

  const handleTemplateClick = (template: SpecTemplate) => {
    setSelectedTemplate(template)
    setShowDetail(true)
  }

  const handleBack = () => {
    setShowDetail(false)
    setSelectedTemplate(null)
  }

  const handleSubmitParams = (params: Record<string, string>) => {
    if (!selectedTemplate) return
    onSelectTemplate(selectedTemplate, params)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-2xl max-h-[85vh] flex flex-col">
      <DialogClose onClose={() => onOpenChange(false)} />

      {!showDetail ? (
        /* ── Template List View ─────────────────────────────────────────── */
        <>
          <DialogHeader>
            <DialogTitle>Spec Templates</DialogTitle>
            <DialogDescription>
              Choose a template to start a structured coding task
            </DialogDescription>
          </DialogHeader>

          {/* Search */}
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <Input
              placeholder="Search templates..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Category tabs */}
          <div className="flex gap-1 mb-4 flex-wrap">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                onClick={() => setSelectedCategory(cat.value)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
                  selectedCategory === cat.value
                    ? 'bg-violet-600 text-white'
                    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-800'
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Template cards */}
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {loading && (
              <div className="py-8 text-center text-sm text-zinc-500">Loading templates...</div>
            )}
            {!loading && filteredTemplates.length === 0 && (
              <div className="py-8 text-center text-sm text-zinc-500">No templates found</div>
            )}
            {filteredTemplates.map((template) => {
              const modeInfo = MODE_BADGE[template.recommendedMode]
              return (
                <button
                  key={template.id}
                  onClick={() => handleTemplateClick(template)}
                  className={cn(
                    'w-full text-left rounded-xl border border-zinc-200 bg-white p-4 transition-all duration-200',
                    'hover:border-violet-300 hover:shadow-sm group'
                  )}
                >
                  <div className="flex items-start gap-3">
                    {/* Icon */}
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 group-hover:bg-violet-100 group-hover:text-violet-600">
                      {ICON_MAP[template.icon] || <ListChecks className="h-5 w-5" />}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-zinc-900">{template.name}</span>
                        {modeInfo && (
                          <Badge variant={modeInfo.variant} className="gap-1 text-xs">
                            {MODE_ICON[template.recommendedMode]}
                            {modeInfo.label}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-zinc-400 line-clamp-2 mb-2">{template.description}</p>
                      <div className="flex items-center gap-3 text-xs text-zinc-500">
                        <span>{template.steps.length} steps</span>
                        <span>·</span>
                        <span>{template.parameters.filter((p) => p.required).length} required params</span>
                        <span>·</span>
                        <span className="capitalize">{template.category}</span>
                      </div>
                    </div>

                    <ChevronRight className="h-4 w-4 text-zinc-600 group-hover:text-zinc-400 mt-2 shrink-0" />
                  </div>
                </button>
              )
            })}
          </div>
        </>
      ) : (
        /* ── Template Detail / Parameter Form ──────────────────────────── */
        selectedTemplate && (
          <>
            {/* Back button */}
            <button
              onClick={handleBack}
              className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 mb-3 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to templates
            </button>

            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
                  {ICON_MAP[selectedTemplate.icon] || <ListChecks className="h-5 w-5" />}
                </div>
                <div>
                  <DialogTitle className="mb-0">{selectedTemplate.name}</DialogTitle>
                  <DialogDescription>{selectedTemplate.description}</DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {/* Steps preview */}
            <div className="mb-4">
              <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Workflow Steps</div>
              <div className="flex items-center gap-1 flex-wrap">
                {selectedTemplate.steps.map((step, i) => (
                  <React.Fragment key={i}>
                    <div className="flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-violet-100 text-[10px] font-bold text-violet-600">
                        {i + 1}
                      </span>
                      <span className="text-xs text-zinc-700">{step.title}</span>
                    </div>
                    {i < selectedTemplate.steps.length - 1 && (
                      <ChevronRight className="h-3 w-3 text-zinc-700 shrink-0" />
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>

            {/* Step descriptions */}
            <div className="mb-4 space-y-1">
              {selectedTemplate.steps.map((step, i) => (
                <div key={i} className="flex gap-2 rounded-lg bg-zinc-50 px-3 py-2">
                  <span className="text-xs font-bold text-zinc-600 shrink-0 mt-0.5">{i + 1}.</span>
                  <div>
                    <span className="text-xs font-medium text-zinc-700">{step.title}</span>
                    <span className="text-xs text-zinc-500 ml-2">— {step.description}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Parameter form */}
            <div className="flex-1 overflow-y-auto pr-1">
              <SpecParameterForm
                parameters={selectedTemplate.parameters}
                onSubmit={handleSubmitParams}
                submitLabel={`Start ${selectedTemplate.name}`}
              />
            </div>
          </>
        )
      )}
    </Dialog>
  )
}
