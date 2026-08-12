import type { ToolContext, ToolExecutor } from './index'
import { runBrowserObserve, runBrowserInteraction, runBrowserSpreadsheetPaste } from './browser-control-tools'

/**
 * Form and table filling is deliberately a workflow tool, separate from the
 * browser's low-level open/observe/interact primitives.
 */
export function createFormFillWorkflowTools(): ToolExecutor[] {
  return [formFillWorkflowTool]
}

const formFillWorkflowTool: ToolExecutor = {
  definition: {
    name: 'form_fill_workflow',
    description: 'Prepare, validate, and execute a browser form or table filling workflow from explicit field mappings. It can paste TSV into the currently selected spreadsheet cell without visual coordinates. It never submits or sends data; final submission must be performed with browser_control and confirmSubmit: true after review.',
    parameters: {
      type: 'object',
      properties: {
        browserSessionId: { type: 'string', description: 'Browser session returned by browser_control open.' },
        action: { type: 'string', enum: ['analyze', 'fill', 'paste_table'], description: 'Analyze available form fields, fill explicit mappings, or paste TSV values starting at the currently selected spreadsheet cell.' },
        mappings: { type: 'array', description: 'For fill: entries with an observed CSS selector and a value. Do not include passwords or credentials.', items: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, kind: { type: 'string', enum: ['text', 'select'] } }, required: ['selector', 'value'] } },
        tsv: { type: 'string', description: 'For paste_table: tab-separated rows to insert from the currently selected spreadsheet cell. Do not include credentials or data the user did not authorize.' },
      },
      required: ['browserSessionId', 'action'],
    },
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const browserSessionId = typeof params.browserSessionId === 'string' ? params.browserSessionId : ''
    const action = params.action
    if (!browserSessionId) throw new Error('browserSessionId is required.')
    if (action === 'analyze') return runBrowserObserve(browserSessionId, context.conversationId)
    if (action === 'paste_table') {
      if (typeof params.tsv !== 'string') throw new Error('paste_table requires tsv text.')
      const result = await runBrowserSpreadsheetPaste(browserSessionId, context.conversationId, params.tsv)
      return JSON.stringify({ ...result, submitRequired: true, guidance: 'The TSV values were pasted from the currently selected spreadsheet cell. Observe the browser to verify the grid before saving or submitting.' })
    }
    if (action !== 'fill') throw new Error('action must be analyze or fill.')
    if (!Array.isArray(params.mappings) || params.mappings.length === 0) throw new Error('fill requires at least one explicit selector/value mapping.')
    const results: Array<Record<string, unknown>> = []
    for (const entry of params.mappings) {
      if (!entry || typeof entry !== 'object') throw new Error('Each mapping must be an object.')
      const mapping = entry as { selector?: unknown; value?: unknown; kind?: unknown }
      if (typeof mapping.selector !== 'string' || !mapping.selector.trim()) throw new Error('Each mapping requires a selector returned by browser_control observe.')
      if (typeof mapping.value !== 'string') throw new Error('Each mapping value must be text.')
      const interaction = mapping.kind === 'select' ? 'select' : 'type'
      const result = await runBrowserInteraction(browserSessionId, context.conversationId, { interaction, selector: mapping.selector, ...(interaction === 'select' ? { value: mapping.value } : { text: mapping.value }) })
      results.push({ selector: mapping.selector, valueCharacters: mapping.value.length, ...result.result })
    }
    return JSON.stringify({ browserSessionId, filled: results.length, results, submitRequired: true, guidance: 'Review the visible page now. Do not submit until the user explicitly approves the final browser_control action with confirmSubmit: true.' })
  },
}
