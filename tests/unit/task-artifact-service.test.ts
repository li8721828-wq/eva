import { describe, expect, it } from 'vitest'
import { toTaskArtifactRun } from '../../src/main/services/task-artifact-service'
import type { Conversation } from '../../src/shared/types/conversation'
import type { TaskRunSnapshot } from '../../src/shared/types/task'

const conversation: Conversation = {
  id: 'conversation-1',
  title: 'Research AI agents',
  agentId: 'eva',
  mode: 'goal',
  workspaceId: 'workspace-1',
  workspacePath: 'C:/work/project',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 3,
}

describe('toTaskArtifactRun', () => {
  it('extracts plans, research sources and successful generated files without duplicating raw data', () => {
    const snapshot: TaskRunSnapshot = {
      conversationId: conversation.id,
      kind: 'goal',
      status: 'completed',
      updatedAt: 4,
      checkpoints: [{
        id: 'plan-created',
        title: 'Execution plan created',
        status: 'recorded',
        createdAt: 2,
        feedback: [{ id: 'feedback-1', content: 'Prioritize primary sources.', createdAt: 3, checkpointId: 'plan-created' }],
      }],
      progress: {
        conversationId: conversation.id,
        goal: 'Research current AI agents',
        currentStepIndex: 0,
        totalSteps: 1,
        status: 'completed',
        startedAt: 1,
        steps: [{
          id: 'step-1',
          index: 0,
          description: 'Collect sources and save a report',
          status: 'completed',
          result: 'Report saved.',
          toolCalls: [
            { id: 'search-1', name: 'web_search', arguments: { query: 'AI agents 2026' }, result: 'Result list' },
            { id: 'page-1', name: 'read_web_page', arguments: { url: 'https://example.com/report' }, result: 'Page text' },
            { id: 'file-1', name: 'write_file', arguments: { path: 'reports/agents.md' }, result: 'Successfully wrote to reports/agents.md' },
            { id: 'failed-file', name: 'write_file', arguments: { path: 'reports/failed.md' }, result: 'Denied', isError: true },
          ],
        }],
      },
    }

    const result = toTaskArtifactRun(snapshot, conversation)

    expect(result.goal).toBe('Research current AI agents')
    expect(result.agentId).toBe('eva')
    expect(result.steps).toHaveLength(1)
    expect(result.sources.map((source) => source.title)).toEqual(['AI agents 2026', 'https://example.com/report'])
    expect(result.files).toEqual([expect.objectContaining({ title: 'agents.md', path: 'reports/agents.md' })])
    expect(result.tools).toHaveLength(4)
    expect(result.checkpoints[0]?.feedback[0]?.content).toBe('Prioritize primary sources.')
  })

  it('uses team assignments as plan steps for expert tasks', () => {
    const snapshot: TaskRunSnapshot = {
      conversationId: conversation.id,
      kind: 'expert',
      status: 'completed',
      updatedAt: 4,
      plan: {
        id: 'plan-1',
        goal: 'Prepare a research report',
        createdAt: 1,
        status: 'completed',
        subtasks: [{
          id: 'task-1',
          planId: 'plan-1',
          title: 'Find sources',
          description: 'Find reliable sources.',
          status: 'completed',
          assignedAgentName: 'Researcher Jack',
          assignedModel: 'deepseek-v4-pro',
          dependencies: [],
          result: 'Three sources collected.',
          toolCalls: [{ id: 'file-1', name: 'write_file', arguments: { path: 'research/sources.md' } }],
        }],
      },
    }

    const result = toTaskArtifactRun(snapshot, conversation)

    expect(result.goal).toBe('Prepare a research report')
    expect(result.steps[0]).toEqual(expect.objectContaining({ title: 'Find sources', detail: 'Researcher Jack · deepseek-v4-pro' }))
    expect(result.files[0]).toEqual(expect.objectContaining({ path: 'research/sources.md' }))
  })

  it('combines repeated file writes and tool calls into counted task artifacts', () => {
    const snapshot: TaskRunSnapshot = {
      conversationId: conversation.id,
      kind: 'goal',
      status: 'completed',
      updatedAt: 4,
      progress: {
        conversationId: conversation.id,
        goal: 'Create a report',
        currentStepIndex: 0,
        totalSteps: 1,
        status: 'completed',
        startedAt: 1,
        steps: [{
          id: 'step-1', index: 0, description: 'Write the report', status: 'completed', toolCalls: [
            { id: 'read-1', name: 'read_file', arguments: { path: 'input.md' } },
            { id: 'read-2', name: 'read_file', arguments: { path: 'input.md' } },
            { id: 'write-1', name: 'write_file', arguments: { path: 'reports/final.md' } },
            { id: 'write-2', name: 'write_file', arguments: { path: 'reports/final.md' } },
          ],
        }],
      },
    }

    const result = toTaskArtifactRun(snapshot, conversation)

    expect(result.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'read file', count: 2 }),
      expect.objectContaining({ title: 'write file', count: 2 }),
    ]))
    expect(result.files).toEqual([expect.objectContaining({ path: 'reports/final.md', count: 2 })])
  })
})
