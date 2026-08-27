import React from 'react'
import { AlignLeft, BookOpenText, BrainCircuit, Check, CircleSlash, FileCode2, Gauge, ListFilter, MessageCircleMore, PanelTop, Sparkles } from 'lucide-react'
import type { AgentMarkdownRenderer, AgentOutputColor, AgentOutputFont, AgentOutputFontSize, AgentOutputFormat, AgentOutputStyle, AgentOutputTextEffect, AgentProcessOutput } from '../../../shared/types'
import { Textarea } from '@/components/ui/Textarea'
import { cn } from '@/lib/utils'

export interface OutputFormatPanelProps {
  outputFormat: AgentOutputFormat
  outputFormatInstructions: string
  outputStyle: AgentOutputStyle
  outputFont: AgentOutputFont
  outputColor: AgentOutputColor
  outputFontSize: AgentOutputFontSize
  outputTextEffect: AgentOutputTextEffect
  markdownRenderer: AgentMarkdownRenderer
  processOutput: AgentProcessOutput
  onOutputFormatChange: (format: AgentOutputFormat) => void
  onOutputFormatInstructionsChange: (instructions: string) => void
  onOutputStyleChange: (style: AgentOutputStyle) => void
  onOutputFontChange: (font: AgentOutputFont) => void
  onOutputColorChange: (color: AgentOutputColor) => void
  onOutputFontSizeChange: (size: AgentOutputFontSize) => void
  onOutputTextEffectChange: (effect: AgentOutputTextEffect) => void
  onMarkdownRendererChange: (renderer: AgentMarkdownRenderer) => void
  onProcessOutputChange: (processOutput: AgentProcessOutput) => void
}

const responseModes: Array<{ value: AgentOutputFormat; label: string; description: string; icon: React.ElementType }> = [
  { value: 'none', label: '无格式约束', description: '不向模型添加回复格式或写作偏好。', icon: CircleSlash },
  { value: 'default', label: '自然表达', description: '由模型根据任务选择最合适的表达方式。', icon: Sparkles },
  { value: 'concise', label: '简洁直接', description: '优先结论和必要信息，减少重复说明。', icon: Gauge },
  { value: 'structured', label: '清晰分段', description: '内容较多时使用轻量标题和列表组织。', icon: PanelTop },
  { value: 'markdown', label: 'Markdown', description: '在有助于阅读时使用标准 Markdown。', icon: AlignLeft },
  { value: 'focus', label: '重点优先', description: '先给主线，再按主题归组数据与依据。', icon: ListFilter },
  { value: 'reading', label: '舒展阅读', description: '更宽松的段落、清晰标题和舒适的阅读版心。', icon: BookOpenText },
  { value: 'typora', label: 'Typora Markdown', description: '按 Typora 的 GFM 阅读与排版习惯输出。', icon: FileCode2 },
  { value: 'feishu', label: '飞书 Markdown', description: '按飞书兼容的 Markdown 子集输出。', icon: FileCode2 },
  { value: 'claude', label: 'Claude 式表达', description: '自然、克制、有条理，少标题和少量必要强调。', icon: MessageCircleMore },
  { value: 'custom', label: '自定义偏好', description: '补充写作习惯，不强制固定模板。', icon: BookOpenText },
]

const visualStyles: Array<{ value: AgentOutputStyle; label: string; description: string }> = [
  { value: 'none', label: '无样式约束', description: '不额外调整 Markdown 的行距、段距或标题节奏。' },
  { value: 'balanced', label: '平衡', description: '默认阅读密度与层级。' },
  { value: 'compact', label: '紧凑', description: '减少留白，适合操作型回复。' },
  { value: 'editorial', label: '舒展', description: '增加段落呼吸感，适合长文说明。' },
  { value: 'technical', label: '技术', description: '提高代码和结构化信息的对比度。' },
  { value: 'claude', label: 'Claude 式阅读', description: '舒适行距、低对比层级，适合自然长对话。' },
]

const fontOptions: Array<{ value: AgentOutputFont; label: string; className: string }> = [
  { value: 'system', label: '系统无衬线', className: '' },
  { value: 'macos', label: 'macOS 原生', className: '' },
  { value: 'serif', label: '阅读衬线', className: 'font-serif' },
  { value: 'mono', label: '技术等宽', className: 'font-mono' },
]

const colorOptions: Array<{ value: AgentOutputColor; label: string; swatch: string }> = [
  { value: 'slate', label: '石墨灰', swatch: 'bg-slate-600' },
  { value: 'ink', label: '墨黑', swatch: 'bg-zinc-800' },
  { value: 'violet', label: '柔紫', swatch: 'bg-violet-600' },
  { value: 'forest', label: '松绿', swatch: 'bg-emerald-700' },
  { value: 'claude', label: 'Claude 暖橙', swatch: 'bg-orange-600' },
]

const fontSizes: Array<{ value: AgentOutputFontSize; label: string; sample: string }> = [
  { value: 'xsmall', label: '特小', sample: '13 px' },
  { value: 'small', label: '小', sample: '14 px' },
  { value: 'medium', label: '默认', sample: '15 px' },
  { value: 'large', label: '大', sample: '16 px' },
  { value: 'xlarge', label: '特大', sample: '17 px' },
  { value: '2xlarge', label: '超大', sample: '18 px' },
  { value: '3xlarge', label: '巨型', sample: '20 px' },
]

const textEffects: Array<{ value: AgentOutputTextEffect; label: string; sampleClassName: string }> = [
  { value: 'none', label: '无效果', sampleClassName: '' },
  { value: 'three-d', label: '3D', sampleClassName: 'text-effect-preview--three-d' },
  { value: 'floating', label: '悬浮', sampleClassName: 'text-effect-preview--floating' },
  { value: 'crystal', label: '水晶', sampleClassName: 'text-effect-preview--crystal' },
]

const markdownRenderers: Array<{ value: AgentMarkdownRenderer; label: string; description: string; icon: React.ElementType }> = [
  { value: 'enhanced', label: '当前增强', description: '强化表格容器、深色代码面板与单段复制操作。', icon: Sparkles },
  { value: 'classic', label: '经典文档', description: '恢复 8 月 12 日的开放式正文、标题、列表与表格节奏；保留代码复制。', icon: BookOpenText },
  { value: 'streamdown', label: 'Streamdown 流式', description: '针对模型逐段生成优化，平稳处理未闭合表格、链接和代码块。', icon: Gauge },
]

function ChoiceRow({ selected, icon: Icon, label, description, onClick }: { selected: boolean; icon?: React.ElementType; label: string; description: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={cn('group flex w-full items-center gap-3 rounded-md border px-3.5 py-3 text-left transition-colors', selected ? 'border-violet-200 bg-violet-50/70' : 'border-transparent bg-zinc-50/75 hover:border-zinc-200 hover:bg-white')}>
    {Icon ? <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', selected ? 'bg-violet-100 text-violet-600' : 'bg-white text-zinc-400')}><Icon className="h-3.5 w-3.5" /></span> : null}
    <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-zinc-800">{label}</span><span className="mt-0.5 block text-xs leading-5 text-zinc-500">{description}</span></span>
    <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', selected ? 'border-violet-500 bg-violet-500 text-white' : 'border-zinc-300 bg-white')} aria-hidden="true">{selected && <Check className="h-2.5 w-2.5" />}</span>
  </button>
}

export function OutputFormatPanel({ outputFormat, outputFormatInstructions, outputStyle, outputFont, outputColor, outputFontSize, outputTextEffect, markdownRenderer, processOutput, onOutputFormatChange, onOutputFormatInstructionsChange, onOutputStyleChange, onOutputFontChange, onOutputColorChange, onOutputFontSizeChange, onOutputTextEffectChange, onMarkdownRendererChange, onProcessOutputChange }: OutputFormatPanelProps) {
  return <div className="space-y-8">
    <section>
      <div><h2 className="text-base font-semibold text-zinc-900">Markdown 渲染器</h2><p className="mt-1 text-sm leading-6 text-zinc-500">决定回复在对话中的视觉排版，不改变模型生成的内容。</p></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">{markdownRenderers.map((renderer) => <ChoiceRow key={renderer.value} selected={markdownRenderer === renderer.value} icon={renderer.icon} label={renderer.label} description={renderer.description} onClick={() => onMarkdownRendererChange(renderer.value)} />)}</div>
      {markdownRenderer === 'classic' ? <p className="mt-3 text-xs leading-5 text-zinc-500">经典文档保留开放式排版与浅色代码主题；阅读样式、字体、色调和字号仍按此智能体的设置生效。</p> : null}
      {markdownRenderer === 'streamdown' ? <p className="mt-3 text-xs leading-5 text-zinc-500">仅在模型输出过程中启用流式修复；关闭逐字动画，避免高频闪动。回复完成后自动切为静态渲染。</p> : null}
    </section>

    <section>
      <div><h2 className="text-base font-semibold text-zinc-900">回复表达</h2><p className="mt-1 text-sm leading-6 text-zinc-500">这只影响组织和阅读方式，不限制模型回答的内容与发挥。</p></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">{responseModes.map((mode) => <ChoiceRow key={mode.value} selected={outputFormat === mode.value} icon={mode.icon} label={mode.label} description={mode.description} onClick={() => onOutputFormatChange(mode.value)} />)}</div>
      {outputFormat === 'custom' && <div className="mt-4 rounded-md bg-zinc-50 p-3.5"><label className="mb-1.5 block text-xs font-medium text-zinc-700">写作偏好</label><Textarea value={outputFormatInstructions} onChange={(event) => onOutputFormatInstructionsChange(event.target.value)} placeholder="例如：先给结论，再简要说明关键取舍。" rows={3} className="bg-white text-sm" /><p className="mt-1.5 text-xs leading-5 text-zinc-500">这是一条偏好，而不是固定格式；智能体仍会根据任务调整回答。</p></div>}
    </section>

    {markdownRenderer !== 'streamdown' ? <section className="border-t border-zinc-100 pt-7">
      <div><h2 className="text-base font-semibold text-zinc-900">阅读样式</h2><p className="mt-1 text-sm leading-6 text-zinc-500">统一正文、标题、列表、表格和代码的密度，避免同一段回复忽大忽小。</p></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">{visualStyles.map((style) => <ChoiceRow key={style.value} selected={outputStyle === style.value} label={style.label} description={style.description} onClick={() => onOutputStyleChange(style.value)} />)}</div>
      <div className="mt-4 flex flex-wrap gap-2">{fontOptions.map((font) => <button key={font.value} type="button" onClick={() => onOutputFontChange(font.value)} className={cn('rounded-md border px-3 py-2 text-sm transition-colors', outputFont === font.value ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300', font.className)}>{font.label}</button>)}</div>
      <div className="mt-4"><p className="mb-2 text-xs font-medium text-zinc-600">正文字号</p><div className="grid grid-cols-4 gap-1 rounded-md bg-zinc-100/80 p-1 sm:grid-cols-7">{fontSizes.map((size) => <button key={size.value} type="button" onClick={() => onOutputFontSizeChange(size.value)} className={cn('min-w-0 rounded px-2.5 py-1.5 text-left transition-colors', outputFontSize === size.value ? 'bg-white text-violet-700 shadow-sm' : 'text-zinc-500 hover:text-zinc-700')}><span className="block text-xs font-medium">{size.label}</span><span className="block text-[10px] leading-4 text-zinc-400">{size.sample}</span></button>)}</div></div>
      <div className="mt-4"><p className="mb-2 text-xs font-medium text-zinc-600">艺术字效果</p><div className="flex flex-wrap gap-2">{textEffects.map((effect) => <button key={effect.value} type="button" onClick={() => onOutputTextEffectChange(effect.value)} className={cn('min-w-16 rounded-md border px-3 py-2 text-sm transition-colors', outputTextEffect === effect.value ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300')}><span className={cn('text-effect-preview', effect.sampleClassName)}>{effect.label}</span></button>)}</div><p className="mt-1.5 text-xs leading-5 text-zinc-500">仅作用于回复标题和加粗强调，正文与代码保持清晰。</p></div>
      <div className="mt-4"><p className="mb-2 text-xs font-medium text-zinc-600">文字色调</p><div className="flex flex-wrap gap-2">{colorOptions.map((color) => <button key={color.value} type="button" onClick={() => onOutputColorChange(color.value)} className={cn('inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors', outputColor === color.value ? 'border-violet-200 bg-violet-50 text-violet-700' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300')}><span className={cn('h-3 w-3 rounded-full', color.swatch)} />{color.label}</button>)}</div></div>
      <p className="mt-2 text-xs leading-5 text-zinc-500">代码块始终使用等宽字体。后续的艺术字体会作为这里的视觉主题添加，不改变模型提示词。</p>
    </section> : null}

    <section className="border-t border-zinc-100 pt-7">
      <div><h2 className="text-base font-semibold text-zinc-900">过程输出</h2><p className="mt-1 text-sm leading-6 text-zinc-500">控制用户在对话中看到的处理过程，不改变工具执行本身。</p></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <ChoiceRow selected={processOutput === 'off'} icon={CircleSlash} label="关闭" description="只保留最终回复与执行动效。" onClick={() => onProcessOutputChange('off')} />
        <ChoiceRow selected={processOutput === 'compact'} icon={Gauge} label="简洁" description="仅在阶段变化时显示短进度。" onClick={() => onProcessOutputChange('compact')} />
        <ChoiceRow selected={processOutput === 'detailed'} icon={BrainCircuit} label="详细" description="支持时请求并显示模型慢思考。" onClick={() => onProcessOutputChange('detailed')} />
      </div>
    </section>
  </div>
}
