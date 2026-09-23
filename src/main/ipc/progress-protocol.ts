import type { ProgressUpdateKind } from '../../shared/types/conversation'

/**
 * The `<eva-progress>` markup a model emits during a run is internal transport,
 * not answer text. This module owns both directions of that protocol: pulling
 * the updates out of a streamed buffer, and scrubbing the markup off the
 * canonical reply. Kept free of Electron imports so it stays unit-testable.
 */

/** Mask credential-shaped text before it can reach a persisted progress row. */
export function redactExecutionText(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [已隐藏]')
}

export function summarizeExecutionText(value: unknown, limit = 260): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = redactExecutionText(value.replace(/\s+/g, ' ').trim())
  if (!normalized) return undefined
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

/**
 * Pre-tool narration ("先看一下目录结构") is intermediate reasoning and stays
 * a progress card, but a model can also write real answer sections before a
 * tool cycle. Structured Markdown (headings, numbered lists, tables, fences)
 * or a substantial paragraph is answer content: dropping it made the persisted
 * reply start mid-sentence and scattered its beginning as thinking fragments.
 */
export function isAnswerLikeContent(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  if (/^ {0,3}#{1,6}\s/m.test(text)) return true
  if (/^ {0,3}\d+\s*[.)]\s/m.test(text)) return true
  if (/^\s*\|.+\|\s*$/m.test(text)) return true
  if (/^ {0,3}(```|~~~)/m.test(text)) return true
  return text.length >= 220
}

/** Keep intermediate narration readable as a sequence of small work units. */
export function splitExecutionSegments(value: string, limit = 220): string[] {
  const normalized = redactExecutionText(value.replace(/\s+/g, ' ').trim())
  if (!normalized) return []
  const sentences = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [normalized]
  const segments: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const next = `${current}${sentence}`.trim()
    if (current && next.length > limit) {
      segments.push(current)
      current = sentence.trim()
    } else {
      current = next
    }
  }
  if (current) segments.push(current)
  return segments.flatMap((segment) => {
    if (segment.length <= limit) return [segment]
    const chunks: string[] = []
    for (let index = 0; index < segment.length; index += limit) chunks.push(segment.slice(index, index + limit))
    return chunks
  })
}

/**
 * A plan or a step report is a small document rather than a status line: its
 * numbered lines carry the meaning, so unlike `summarizeExecutionText` this
 * keeps line breaks and only collapses horizontal runs and blank-line runs.
 */
export function normalizeProgressBlock(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = redactExecutionText(value)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!normalized) return undefined
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

/** Single source of truth for the tag kinds: the extractor and both strip
 *  regexes below must stay in sync, otherwise raw tag markup leaks into the
 *  persisted answer. */
export const PROGRESS_TAG_KINDS = 'thinking|finding|action|issue|plan|step'
/** Plan and step reports keep their own length budgets instead of sharing the
 *  per-fragment limit, so a multi-line plan is never hard-split mid-line. */
export const PROGRESS_BLOCK_LIMITS: Partial<Record<ProgressUpdateKind, number>> = { plan: 700, step: 900 }

/**
 * `item` names the plan line a step report completes (1-based, counted over the
 * plan block's own lines). It is optional: a step without it completes the next
 * unticked line, so an older model keeps working and only the ticking is looser.
 * Attributes are captured as a bag rather than positionally, so `kind` and
 * `item` may arrive in either order without the report being dropped.
 */
const progressTagPattern = /<eva-progress((?:\s+[\w-]+=["'][^"']*["'])*)\s*>([\s\S]*?)<\/eva-progress>/gi
const progressKindAttributePattern = new RegExp(`\\bkind=["'](${PROGRESS_TAG_KINDS})["']`, 'i')
const progressItemAttributePattern = /\bitem=["'](\d+)["']/i
/** Scrubbing accepts any attribute bag, in any order, so a model that writes
 *  `item` before `kind` still has its markup removed from the answer. */
const progressTagStripPattern = /<eva-progress[^>]*>[\s\S]*?<\/eva-progress>/gi
const progressTagFragmentPattern = /<eva-progress[^>]*>|<\/eva-progress>/gi

export interface ExtractedProgressUpdate {
  kind: ProgressUpdateKind
  content: string
  /** Plan line completed by this step, when the model named one. */
  item?: number
}

export function extractProgressUpdates(content: string): ExtractedProgressUpdate[] {
  const updates: ExtractedProgressUpdate[] = []
  progressTagPattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = progressTagPattern.exec(content))) {
    const attributes = match[1] || ''
    const kind = (attributes.match(progressKindAttributePattern)?.[1]?.toLowerCase() as ProgressUpdateKind | undefined) || 'thinking'
    const blockLimit = PROGRESS_BLOCK_LIMITS[kind]
    const summary = blockLimit ? normalizeProgressBlock(match[2], blockLimit) : summarizeExecutionText(match[2], 520)
    if (!summary) continue
    const item = Number.parseInt(attributes.match(progressItemAttributePattern)?.[1] || '', 10)
    updates.push(Number.isInteger(item) && item > 0 ? { kind, content: summary, item } : { kind, content: summary })
  }
  return updates
}

/**
 * A captured progress block as it should reach the user: a plan or a step report
 * is one document whose numbered lines carry the meaning, so it keeps its line
 * breaks and its own length budget; the legacy kinds are narration and get split
 * into sentence-sized fragments so a long aside does not become one wall of text.
 *
 * Shared because every transport that shows a turn has to chunk it the same way
 * — a second copy drifting is how the desktop and a remote client end up showing
 * different numbers of cards for the same run.
 */
export function toProgressSummaries(
  kind: ProgressUpdateKind,
  content: string,
  characterLimit = 220,
): string[] {
  const blockLimit = PROGRESS_BLOCK_LIMITS[kind]
  if (blockLimit) {
    const normalized = normalizeProgressBlock(content, blockLimit)
    return normalized ? [normalized] : []
  }
  return splitExecutionSegments(content, characterLimit)
    .map((segment) => summarizeExecutionText(segment, characterLimit))
    .filter((summary): summary is string => Boolean(summary))
}

/** Drop every progress block, tagged or not, from a finished reply. */
export function stripProgressBlocks(content: string): string {
  return content.replace(progressTagStripPattern, '')
}

/**
 * Remove only the tag delimiters and keep the text inside, for the case where
 * the model wrapped its actual answer in `<eva-progress>`. Used as a fallback
 * so scrubbing the markup can never turn a real reply into an empty one.
 */
export function unwrapProgressTags(content: string): string {
  return content.replace(progressTagFragmentPattern, '')
}

const progressOpeningTag = '<eva-progress'
const progressClosingTag = '</eva-progress>'

export type ProjectedTurnSegment =
  | { type: 'text'; content: string }
  | { type: 'progress'; kind: ProgressUpdateKind; content: string; item?: number }

/**
 * Splits a streamed reply into visible answer text and progress reports, in the
 * order the model produced them. Held as one class because every transport that
 * shows a turn needs the same projection: an unstripped `<eva-progress>` tag
 * reaching a client is either a broken card or raw XML inside the answer, and
 * a tag split across two chunks must not be forwarded as text.
 *
 * `feed` stays synchronous and returns ordered segments rather than awaiting a
 * callback, so each host decides where its updates go (IPC stream, SSE, WS)
 * without this class knowing about any of them.
 */
export class TurnProgressProjector {
  private pending = ''

  feed(chunk: string): ProjectedTurnSegment[] {
    const segments: ProjectedTurnSegment[] = []
    this.pending += chunk

    while (this.pending) {
      const normalized = this.pending.toLowerCase()
      const openingIndex = normalized.indexOf(progressOpeningTag)

      if (openingIndex < 0) {
        // A tag opener can be split across chunks. Retain only the small
        // matching suffix and immediately forward everything else.
        const maxPrefixLength = Math.min(progressOpeningTag.length - 1, this.pending.length)
        let retainedLength = 0
        for (let length = maxPrefixLength; length > 0; length--) {
          if (progressOpeningTag.startsWith(normalized.slice(-length))) {
            retainedLength = length
            break
          }
        }
        const visible = this.pending.slice(0, this.pending.length - retainedLength)
        this.pending = this.pending.slice(this.pending.length - retainedLength)
        if (visible) segments.push({ type: 'text', content: visible })
        return segments
      }

      if (openingIndex > 0) {
        segments.push({ type: 'text', content: this.pending.slice(0, openingIndex) })
        this.pending = this.pending.slice(openingIndex)
        continue
      }

      const closingIndex = normalized.indexOf(progressClosingTag)
      if (closingIndex < 0) return segments

      const markupEnd = closingIndex + progressClosingTag.length
      for (const update of extractProgressUpdates(this.pending.slice(0, markupEnd))) {
        segments.push({ type: 'progress', ...update })
      }
      this.pending = this.pending.slice(markupEnd)
    }

    return segments
  }

  /**
   * A tool call can only follow a complete, user-visible progress tag. Drop the
   * malformed/incomplete fragment rather than exposing it.
   */
  discardPending(): void {
    this.pending = ''
  }
}
