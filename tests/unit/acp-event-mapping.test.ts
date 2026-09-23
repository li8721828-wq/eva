import { describe, it, expect } from 'vitest'
import {
  messageChunk,
  planUpdate,
  projectPlan,
  textBlock,
  thoughtChunk,
  toolCallFinished,
  toolCallKind,
  toolCallTitle,
  toolCallUpdate,
} from '../../src/main/services/app-server/acp/event-mapping'
import {
  ACP_UPDATE,
  type AcpPlanEntry,
  type AcpPlanPriority,
  type AcpPlanStatus,
  type AcpSessionNotification,
  type AcpToolCallStatus,
} from '../../src/main/services/app-server/acp/protocol'
import type { PlanChecklist } from '../../src/shared/plan-checklist'
import type { ProgressUpdate, ProgressUpdateKind } from '../../src/shared/types/conversation'

/**
 * The ACP-facing translation layer is allowed to be pure, so it is tested with no
 * socket and no Electron: these are the exact objects the phone terminal parses
 * out of one WebSocket text frame.
 */

const SESSION = 'conv-acp-1'

/** Built the way `emitProgress` in app-server/server.ts builds a progress row. */
const update = (id: string, kind: ProgressUpdateKind, content: string, item?: number): ProgressUpdate => ({
  id,
  kind,
  content,
  ...(item ? { item } : {}),
  timestamp: 0,
})

const PLAN = update('p1', 'plan', '1. 确认重复写入\n2. 修复去重逻辑\n3. 跑全量测试')

const checklist = (items: PlanChecklist['items'], overflowStepCount = 0): PlanChecklist => ({
  items,
  revised: false,
  overflowStepCount,
})

const item = (index: number, text: string, done: boolean): PlanChecklist['items'][number] => ({ index, text, done })

const planOf = (frames: AcpSessionNotification[]): AcpPlanEntry[] | undefined => {
  for (const frame of frames) {
    if (frame.update.sessionUpdate === ACP_UPDATE.PLAN) return frame.update.entries
  }
  return undefined
}

/** Exactly one plan frame, which is what a checklist-driven client may assume. */
const singlePlan = (frames: AcpSessionNotification[]): AcpPlanEntry[] => {
  const plans = frames.filter((frame) => frame.update.sessionUpdate === ACP_UPDATE.PLAN)
  expect(plans).toHaveLength(1)
  return planOf(plans)!
}

const statusesOf = (frames: AcpSessionNotification[]): AcpPlanStatus[] => singlePlan(frames).map((entry) => entry.status)
const contentsOf = (frames: AcpSessionNotification[]): string[] => singlePlan(frames).map((entry) => entry.content)
const thoughtTextsOf = (frames: AcpSessionNotification[]): string[] =>
  frames.flatMap((frame) => (frame.update.sessionUpdate === ACP_UPDATE.AGENT_THOUGHT_CHUNK ? [frame.update.content.text] : []))
const discriminatorsOf = (frames: AcpSessionNotification[]): string[] => frames.map((frame) => frame.update.sessionUpdate)

const ACP_UPDATES = Object.values(ACP_UPDATE) as string[]
const PLAN_STATUSES: AcpPlanStatus[] = ['pending', 'in_progress', 'completed']
const PLAN_PRIORITIES: AcpPlanPriority[] = ['high', 'medium', 'low']
const TOOL_CALL_STATUSES: AcpToolCallStatus[] = ['pending', 'in_progress', 'completed', 'failed']
const TOOL_CALL_KINDS = ['read', 'edit', 'execute', 'fetch', 'other'] as const
/** Eva's own progress/report vocabulary, none of which may reach the wire. */
const EVA_ONLY_KINDS = ['thinking', 'finding', 'action', 'issue', 'step', 'running', 'paused', 'cancelled', 'interrupted']

/** Everything this module emits must already be legal ACP, keys included. */
const expectAcpVocabulary = (frames: AcpSessionNotification[]): void => {
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) {
    expect(Object.keys(frame).sort()).toEqual(['sessionId', 'update'])
    expect(frame.sessionId).toBe(SESSION)
    expect(ACP_UPDATES).toContain(frame.update.sessionUpdate)
    expect(EVA_ONLY_KINDS).not.toContain(frame.update.sessionUpdate)

    const payload = frame.update
    if (payload.sessionUpdate === ACP_UPDATE.PLAN) {
      expect(payload.entries.length).toBeGreaterThan(0)
      for (const entry of payload.entries) {
        expect(Object.keys(entry).sort()).toEqual(['content', 'priority', 'status'])
        expect(typeof entry.content).toBe('string')
        expect(entry.content.length).toBeGreaterThan(0)
        expect(PLAN_PRIORITIES).toContain(entry.priority)
        expect(PLAN_STATUSES).toContain(entry.status)
      }
      continue
    }
    if (payload.sessionUpdate === ACP_UPDATE.TOOL_CALL) {
      expect(Object.keys(payload.toolCall).sort()).toEqual(['kind', 'status', 'title', 'toolCallId'])
      expect(TOOL_CALL_KINDS).toContain(payload.toolCall.kind)
      expect(TOOL_CALL_STATUSES).toContain(payload.toolCall.status)
      continue
    }
    if (payload.sessionUpdate === ACP_UPDATE.TOOL_CALL_UPDATE) {
      expect(TOOL_CALL_STATUSES).toContain(payload.status)
      continue
    }
    // The two chunk kinds are the only frames left, and they are text blocks.
    expect(Object.keys(payload.content).sort()).toEqual(['text', 'type'])
    expect(payload.content.type).toBe('text')
    if (payload.sessionUpdate === ACP_UPDATE.AGENT_THOUGHT_CHUNK) expect('messageId' in payload).toBe(false)
  }
}

/** `planUpdate` answers undefined when there is nothing to show; here it must not. */
const sole = (notification: AcpSessionNotification | undefined): AcpSessionNotification[] => {
  expect(notification).toBeDefined()
  return [notification as AcpSessionNotification]
}

describe('ACP event mapping', () => {
  describe('message and thought chunks', () => {
    it('emits a text content block', () => {
      expect(textBlock('你好')).toEqual({ type: 'text', text: '你好' })
    })

    it('carries the answer chunk with the round messageId on the wire', () => {
      expect(messageChunk(SESSION, 'msg-7', '第一段落')).toEqual({
        sessionId: SESSION,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-7',
          content: { type: 'text', text: '第一段落' },
        },
      })
    })

    it('keeps a thought chunk out of the answer stream by giving it no messageId', () => {
      const frame = thoughtChunk(SESSION, '先确认写入路径')
      expect(frame).toEqual({
        sessionId: SESSION,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先确认写入路径' } },
      })
      expect('messageId' in frame.update).toBe(false)
    })

    it('never drops an empty delta into a frame the client cannot render', () => {
      // The facade is what filters empty deltas out; the mapper stays faithful, so
      // an empty string still has to be a well-formed ACP frame.
      expectAcpVocabulary([messageChunk(SESSION, 'msg-7', '')])
      expect(messageChunk(SESSION, 'msg-7', '').update).toMatchObject({ content: { text: '' } })
    })
  })

  describe('toolCallTitle', () => {
    it('picks query, then command, then path, then file_path, then url, then pattern, then directory', () => {
      expect(toolCallTitle('execute_command', { command: 'npm test', path: '/ignored', url: 'https://ignored' })).toBe('执行命令 npm test')
      expect(toolCallTitle('write_file', { path: 'src/shared/plan-checklist.ts', file_path: '/ignored' })).toBe('写入文件 src/shared/plan-checklist.ts')
      expect(toolCallTitle('write_file', { file_path: 'src/main/index.ts', url: 'https://ignored' })).toBe('写入文件 src/main/index.ts')
      expect(toolCallTitle('read_web_page', { url: 'https://example.com/a', pattern: 'ignored' })).toBe('读取网页 https://example.com/a')
      expect(toolCallTitle('search_by_regex', { pattern: 'buildPlanChecklist', directory: 'src' })).toBe('正则搜索 buildPlanChecklist')
      expect(toolCallTitle('list_directory', { directory: 'src/shared' })).toBe('列出目录 src/shared')
      // The search term beats the directory `search_code` also carries.
      expect(toolCallTitle('search_code', { query: 'buildPlanChecklist', path: 'src/main' })).toBe('搜索代码 buildPlanChecklist')
      expect(toolCallTitle('web_search', { query: 'ACP protocol' })).toBe('联网搜索 ACP protocol')
      // A blank field must not swallow the next candidate.
      expect(toolCallTitle('execute_command', { command: '   ', path: 'src/main/index.ts' })).toBe('执行命令 src/main/index.ts')
    })

    it('prefixes the Chinese label of every tool the runner can call', () => {
      expect(toolCallTitle('read_file', { path: 'a.md' })).toBe('读取文件 a.md')
      expect(toolCallTitle('search_files', { pattern: 'a.md' })).toBe('搜索文件 a.md')
      expect(toolCallTitle('edit_file', { path: 'b.ts' })).toBe('编辑文件 b.ts')
      expect(toolCallTitle('write_terminal', { command: 'git status' })).toBe('终端执行 git status')
      expect(toolCallTitle('read_terminal', { command: 'tail -f log' })).toBe('读取终端 tail -f log')
      // A stand-in target: this mapper reads query/command/path/file_path/url/
      // pattern/directory, so a tool shows whichever of those it carries.
      expect(toolCallTitle('web_search', { url: 'https://example.com' })).toBe('联网搜索 https://example.com')
      expect(toolCallTitle('create_execution_plan', { path: 'plan.md' })).toBe('制定执行计划 plan.md')
    })

    it('falls back to the bare label when there is no usable target', () => {
      expect(toolCallTitle('list_directory', undefined)).toBe('列出目录')
      expect(toolCallTitle('list_directory', {})).toBe('列出目录')
      expect(toolCallTitle('list_directory', { directory: '   ' })).toBe('列出目录')
      expect(toolCallTitle('list_directory', { directory: 42 })).toBe('列出目录')
      expect(toolCallTitle('read_file', { path: '  src/main/index.ts \n' })).toBe('读取文件 src/main/index.ts')
    })

    it('keeps an unknown tool name as its own label instead of inventing one', () => {
      expect(toolCallTitle('mcp__github__list_issues', { path: 'org/repo' })).toBe('mcp__github__list_issues org/repo')
      expect(toolCallTitle('mcp__github__list_issues', {})).toBe('mcp__github__list_issues')
    })

    it('clips a target longer than 160 characters with the ellipsis character', () => {
      const long = 'x'.repeat(200)
      const title = toolCallTitle('execute_command', { command: long })
      expect(title).toBe(`执行命令 ${'x'.repeat(160)}…`)
      expect(title.endsWith('…')).toBe(true)
      expect(title.length).toBe('执行命令'.length + 1 + 160 + '…'.length)
      expect(toolCallTitle('execute_command', { command: 'z'.repeat(161) })).toBe(`执行命令 ${'z'.repeat(160)}…`)
      // 160 is the budget, not a trigger: an exactly-160 target stays whole.
      expect(toolCallTitle('execute_command', { command: 'y'.repeat(160) })).toBe(`执行命令 ${'y'.repeat(160)}`)
      expect(toolCallTitle('execute_command', { command: 'y'.repeat(160) })).not.toContain('…')
    })
  })

  describe('toolCallKind', () => {
    it('maps terminal work to execute', () => {
      expect([toolCallKind('execute_command'), toolCallKind('write_terminal'), toolCallKind('read_terminal')]).toEqual([
        'execute',
        'execute',
        'execute',
      ])
    })

    it('maps writes to edit and reads to read', () => {
      expect([toolCallKind('write_file'), toolCallKind('edit_file')]).toEqual(['edit', 'edit'])
      expect([toolCallKind('read_file'), toolCallKind('list_directory')]).toEqual(['read', 'read'])
    })

    it('treats every search_* tool as a read', () => {
      expect([toolCallKind('search_files'), toolCallKind('search_code'), toolCallKind('search_by_regex')]).toEqual(['read', 'read', 'read'])
      expect(toolCallKind('search_semantic_index')).toBe('read')
    })

    it('maps the network tools to fetch and everything else to other', () => {
      expect([toolCallKind('web_search'), toolCallKind('read_web_page')]).toEqual(['fetch', 'fetch'])
      expect(toolCallKind('create_execution_plan')).toBe('other')
      expect(toolCallKind('mcp__github__list_issues')).toBe('other')
      expect(toolCallKind('')).toBe('other')
    })
  })

  describe('tool call lifecycle', () => {
    it('announces a call already in progress with id, title and kind', () => {
      expect(toolCallUpdate(SESSION, 'call-1', '执行命令 npm test', 'execute_command')).toEqual({
        sessionId: SESSION,
        update: {
          sessionUpdate: 'tool_call',
          toolCall: { toolCallId: 'call-1', title: '执行命令 npm test', kind: 'execute', status: 'in_progress' },
        },
      })
    })

    it('closes a call as completed or failed, keyed by the same toolCallId', () => {
      expect(toolCallFinished(SESSION, 'call-1', false)).toEqual({
        sessionId: SESSION,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' },
      })
      expect(toolCallFinished(SESSION, 'call-2', true)).toEqual({
        sessionId: SESSION,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'failed' },
      })
    })

    it('never reports an errored call as completed', () => {
      const isError = (frame: AcpSessionNotification): AcpToolCallStatus =>
        frame.update.sessionUpdate === ACP_UPDATE.TOOL_CALL_UPDATE ? frame.update.status : 'pending'
      expect(isError(toolCallFinished(SESSION, 'c', Boolean(1)))).toBe('failed')
      expect(isError(toolCallFinished(SESSION, 'c', undefined as unknown as boolean))).toBe('completed')
    })
  })

  describe('planUpdate', () => {
    it('marks only the first unticked entry active while the round is still running', () => {
      const frame = planUpdate(
        SESSION,
        checklist([item(1, '一', true), item(2, '二', false), item(3, '三', false)]),
        true,
      )
      expect(statusesOf(sole(frame))).toEqual(['completed', 'in_progress', 'pending'])
    })

    it('follows an out-of-order tick instead of the ordinal', () => {
      const frame = planUpdate(SESSION, checklist([item(1, '一', false), item(2, '二', true), item(3, '三', false)]), true)
      expect(statusesOf(sole(frame))).toEqual(['in_progress', 'completed', 'pending'])
    })

    it('drops the active marker on the final snapshot', () => {
      const frame = planUpdate(SESSION, checklist([item(1, '一', true), item(2, '二', false), item(3, '三', false)]), false)
      expect(statusesOf(sole(frame))).toEqual(['completed', 'pending', 'pending'])
    })

    it('uses the line text, not Eva numbering, as the entry content', () => {
      const frame = planUpdate(SESSION, checklist([item(1, '确认重复写入', false)]), true)
      expect(singlePlan(sole(frame))).toEqual([{ content: '确认重复写入', priority: 'medium', status: 'in_progress' }])
    })

    it('returns nothing rather than a plan frame with no entries', () => {
      expect(planUpdate(SESSION, checklist([]), true)).toBeUndefined()
      expect(planUpdate(SESSION, checklist([], 3), false)).toBeUndefined()
    })
  })

  describe('projectPlan', () => {
    it('turns the opening plan block into one entry per numbered line', () => {
      const frames = projectPlan(SESSION, [PLAN], true)
      expect(frames).toHaveLength(1)
      expect(singlePlan(frames)).toEqual([
        { content: '确认重复写入', priority: 'medium', status: 'in_progress' },
        { content: '修复去重逻辑', priority: 'medium', status: 'pending' },
        { content: '跑全量测试', priority: 'medium', status: 'pending' },
      ])
    })

    it('strips every list marker style so the entry is the line itself', () => {
      const frames = projectPlan(
        SESSION,
        [update('p', 'plan', '- 破折号\n* 星号\n· 中点\n1) 半角括号\n1、顿号\n（3）全角括号\n\t4. 制表符缩进')],
        true,
      )
      expect(contentsOf(frames)).toEqual(['破折号', '星号', '中点', '半角括号', '顿号', '全角括号', '制表符缩进'])
    })

    it('ticks the line a numbered step names and keeps the first unticked line active', () => {
      const frames = projectPlan(SESSION, [PLAN, update('s2', 'step', '去重逻辑已修复', 2)], true)
      expect(statusesOf(frames)).toEqual(['in_progress', 'completed', 'pending'])
      expect(contentsOf(frames)).toEqual(['确认重复写入', '修复去重逻辑', '跑全量测试'])
    })

    it('completes the first unticked line when the step names no item', () => {
      const oneStep = projectPlan(SESSION, [PLAN, update('s1', 'step', '重复写入已确认')], true)
      expect(statusesOf(oneStep)).toEqual(['completed', 'in_progress', 'pending'])

      const twoSteps = projectPlan(SESSION, [PLAN, update('s1', 'step', '重复写入已确认'), update('s2', 'step', '去重逻辑已修复')], true)
      expect(statusesOf(twoSteps)).toEqual(['completed', 'completed', 'in_progress'])
    })

    it('restarts the ticking when the run publishes a second plan block', () => {
      const revised = update('p2', 'plan', '改为只补测试\n跳过重构')
      const frames = projectPlan(SESSION, [PLAN, update('s1', 'step', '重复写入已确认', 1), revised], true)
      const entries = singlePlan(frames)

      expect(entries.map((entry) => entry.content)).toEqual(['改为只补测试', '跳过重构'])
      // The tick from the superseded plan is gone: nothing in the new block is completed.
      expect(entries.map((entry) => entry.status)).toEqual(['in_progress', 'pending'])
      expect(entries.some((entry) => entry.status === 'completed')).toBe(false)
    })

    it('keeps a revision honest when the numbered items refer to the new block', () => {
      const revised = update('p2', 'plan', '1. 补回归测试\n2. 跑全量测试')
      const frames = projectPlan(SESSION, [PLAN, update('s1', 'step', '旧计划的第一条', 1), revised, update('s2', 'step', '回归测试已补', 1)], true)
      expect(statusesOf(frames)).toEqual(['completed', 'in_progress'])
    })

    it('ends on the truth: the final snapshot has no entry stuck in progress', () => {
      const partial = projectPlan(SESSION, [PLAN, update('s1', 'step', '重复写入已确认', 1)], false)
      expect(statusesOf(partial)).toEqual(['completed', 'pending', 'pending'])

      const finished = projectPlan(SESSION, [
        PLAN,
        update('s1', 'step', '重复写入已确认', 1),
        update('s2', 'step', '去重逻辑已修复', 2),
        update('s3', 'step', '全量测试通过', 3),
      ], false)
      expect(statusesOf(finished)).toEqual(['completed', 'completed', 'completed'])
      expect(statusesOf(finished).some((status) => status === 'in_progress')).toBe(false)
    })

    it('reports steps with no line left to tick as a thought chunk instead of a silent drop', () => {
      const frames = projectPlan(SESSION, [
        update('p', 'plan', '1. 读目录\n2. 改代码'),
        update('s1', 'step', '目录读完了', 1),
        update('s2', 'step', '代码改完了', 2),
        update('s3', 'step', '顺手补了一条日志'),
        update('s4', 'step', '又跑了一遍冒烟'),
      ], true)

      expect(discriminatorsOf(frames)).toEqual([ACP_UPDATE.PLAN, ACP_UPDATE.AGENT_THOUGHT_CHUNK])
      expect(thoughtTextsOf(frames)).toHaveLength(1)
      expect(thoughtTextsOf(frames)[0]).toContain('计划外汇报 2 条')
      expect(thoughtTextsOf(frames)[0].endsWith('：又跑了一遍冒烟')).toBe(true)
      // the overflow never invented a checklist entry
      expect(contentsOf(frames)).toEqual(['读目录', '改代码'])
      expect(statusesOf(frames)).toEqual(['completed', 'completed'])
    })

    it('invents no plan for a run that never published one', () => {
      expect(projectPlan(SESSION, [update('s1', 'step', '先看了一眼目录结构')], true)).toEqual([])
      expect(projectPlan(SESSION, [update('s1', 'step', '先看了一眼目录结构')], false)).toEqual([])
      expect(
        projectPlan(SESSION, [update('u1', 'thinking', '在想'), update('u2', 'action', '在做'), update('u3', 'finding', '看到了')], true),
      ).toEqual([])
      expect(projectPlan(SESSION, [], true)).toEqual([])
    })

    it('still shows a plan-less step as thought text, never as an empty checklist', () => {
      const step = update('s1', 'step', '先看了一眼目录结构')
      // Same pairing the prompt loop does for a step report: the thought chunk
      // carries the text, the projection contributes nothing to show.
      const frames = [thoughtChunk(SESSION, step.content), ...projectPlan(SESSION, [step], true)]
      expect(discriminatorsOf(frames)).toEqual([ACP_UPDATE.AGENT_THOUGHT_CHUNK])
      expect(thoughtTextsOf(frames)).toEqual(['先看了一眼目录结构'])
      expect(planOf(frames)).toBeUndefined()
    })

    it('produces no frame at all for a plan block with no lines in it', () => {
      expect(projectPlan(SESSION, [update('p', 'plan', '\n   \n')], true)).toEqual([])
      expect(projectPlan(SESSION, [update('p', 'plan', '1. \n2. \n')], true)).toEqual([])
    })

    it('reports medium priority for every entry, since Eva plans carry no importance', () => {
      const sequence = [PLAN, update('s1', 'step', '第一条', 1), update('s2', 'step', '第二条'), update('s3', 'step', '第三条')]
      for (const streaming of [true, false]) {
        for (let taken = 1; taken <= sequence.length; taken++) {
          for (const frame of projectPlan(SESSION, sequence.slice(0, taken), streaming)) {
            if (frame.update.sessionUpdate === ACP_UPDATE.PLAN) {
              expect(frame.update.entries.map((r) => r.priority)).toEqual(frame.update.entries.map(() => 'medium'))
            }
          }
        }
      }
    })

    it('re-sends the whole checklist every time, so a client can replace rather than merge', () => {
      const first = projectPlan(SESSION, [PLAN], true)
      const second = projectPlan(SESSION, [PLAN, update('s1', 'step', '重复写入已确认', 1)], true)
      expect(contentsOf(first)).toEqual(contentsOf(second))
      expect(statusesOf(second)).toEqual(['completed', 'in_progress', 'pending'])
    })
  })

  describe('wire vocabulary', () => {
    it('emits only ACP update kinds and statuses for a whole mixed turn', () => {
      const progress = [
        PLAN,
        update('s1', 'step', '重复写入已确认', 1),
        update('s2', 'step', '越界编号', 9),
        update('s3', 'step', '去重完成'),
        update('s4', 'step', '计划之外的补充汇报'),
      ]
      const frames = [
        messageChunk(SESSION, 'msg-7', '开始处理'),
        thoughtChunk(SESSION, '先确认写入路径'),
        toolCallUpdate(SESSION, 'call-1', toolCallTitle('read_file', { path: 'src/shared/plan-checklist.ts' }), 'read_file'),
        toolCallFinished(SESSION, 'call-1', false),
        toolCallUpdate(SESSION, 'call-2', toolCallTitle('write_file', { path: 'src/shared/plan-checklist.ts' }), 'write_file'),
        toolCallFinished(SESSION, 'call-2', true),
        ...projectPlan(SESSION, progress, true),
        ...projectPlan(SESSION, progress, false),
      ]

      expectAcpVocabulary(frames)
      expect(discriminatorsOf(frames)).toEqual([
        'agent_message_chunk',
        'agent_thought_chunk',
        'tool_call',
        'tool_call_update',
        'tool_call',
        'tool_call_update',
        'plan',
        'agent_thought_chunk',
        'plan',
        'agent_thought_chunk',
      ])
      const plan = planOf(frames) as AcpPlanEntry[]
      expect(plan.map((entry) => entry.status)).toEqual(['completed', 'completed', 'completed'])
    })

    it('is safe to hand to a JSON serializer one frame at a time', () => {
      const frames = projectPlan(SESSION, [PLAN, update('s1', 'step', '重复写入已确认', 1)], true)
      for (const frame of frames) {
        const roundTrip = JSON.parse(JSON.stringify(frame))
        expect(roundTrip).toEqual(frame)
        // one text frame = one complete JSON-RPC object downstream of this
        expect(Object.keys(roundTrip).sort()).toEqual(['sessionId', 'update'])
      }
    })
  })
})
