import type { ToolContext, ToolExecutor } from './index'

const MIN_OPTIONS = 2
const MAX_OPTIONS = 6
const MAX_QUESTION_CHARS = 200
const MAX_LABEL_CHARS = 40
const MAX_DETAIL_CHARS = 160

interface RawOption {
  label?: unknown
  detail?: unknown
}

export function createAskUserTools(): ToolExecutor[] {
  return [{
    definition: {
      name: 'ask_user',
      description: 'Put a single question and its candidate answers on screen as clickable options, and wait for the user to pick one inside this turn. Use it only when the next step genuinely depends on a decision the user owns and the possible answers form a small set of discrete, mutually exclusive options. Do not use it for open-ended questions, for restating something the user already said, or to seek permission for an action. Ask one question per call: when several decisions are needed, ask the one that blocks the work first and repeat. The tool returns the label the user chose.',
      parameters: {
        type: 'object',
        required: ['question', 'options'],
        properties: {
          question: { type: 'string', description: `One short question, at most ${MAX_QUESTION_CHARS} characters.` },
          options: {
            type: 'array',
            description: `${MIN_OPTIONS}-${MAX_OPTIONS} mutually exclusive answers. Each label must read as a complete answer on its own, at most ${MAX_LABEL_CHARS} characters. Detail is secondary text shown on hover, so never put the answer there.`,
            items: {
              type: 'object',
              required: ['label'],
              properties: {
                label: { type: 'string', description: 'The answer itself, shown on the button.' },
                detail: { type: 'string', description: `Optional one-line tradeoff, at most ${MAX_DETAIL_CHARS} characters.` },
              },
            },
          },
        },
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
      const requestUserChoice = context.requestUserChoice
      if (!requestUserChoice) {
        throw new Error('这个运行环境没有可以回答选择的界面（例如后台任务或远程通道）。请改用正文文字提问，不要重复调用本工具。')
      }

      const question = typeof params.question === 'string' ? params.question.trim() : ''
      if (!question) throw new Error('question is required.')
      if (question.length > MAX_QUESTION_CHARS) {
        throw new Error(`question is ${question.length} characters; keep it under ${MAX_QUESTION_CHARS} so it fits one card.`)
      }

      const rawOptions = Array.isArray(params.options) ? (params.options as RawOption[]) : []
      if (rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
        throw new Error(`options must hold between ${MIN_OPTIONS} and ${MAX_OPTIONS} entries, got ${rawOptions.length}.`)
      }

      const seen = new Set<string>()
      const options = rawOptions.map((entry, index) => {
        const label = typeof entry.label === 'string' ? entry.label.trim() : ''
        if (!label) throw new Error(`option ${index + 1} has an empty label.`)
        if (label.length > MAX_LABEL_CHARS) {
          throw new Error(`Option "${label.slice(0, 20)}…" is ${label.length} characters; keep labels under ${MAX_LABEL_CHARS}.`)
        }
        const key = label.toLowerCase()
        if (seen.has(key)) throw new Error(`Duplicate option "${label}"; options must be mutually exclusive and distinct.`)
        seen.add(key)
        const rawDetail = typeof entry.detail === 'string' ? entry.detail.trim() : ''
        return {
          id: `opt_${index + 1}`,
          label,
          detail: rawDetail ? rawDetail.slice(0, MAX_DETAIL_CHARS) : undefined,
        }
      })

      const outcome = await requestUserChoice({ question, options })
      if (outcome.status === 'selected') {
        return `用户选择了：${outcome.label}`
      }
      return `用户没有作出选择（${outcome.reason}）。请按你已有的判断继续，不要重复弹出同一个问题。`
    },
  }]
}
