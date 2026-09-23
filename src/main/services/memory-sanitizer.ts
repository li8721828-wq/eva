import type { MemoryEvent, MemoryEventToolSummary } from '../../shared/types/long-term-memory'

const SECRET_PATTERNS = [
  /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*["']?[^"'\s,;]{8,}/gi,
  /\b(?:sk|rk|ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{12,}\b/gi,
]

function redact(value: string, maxChars: number): string {
  let next = value
  for (const pattern of SECRET_PATTERNS) next = next.replace(pattern, '[REDACTED]')
  next = next.replace(/(?:^|\n)\s*[\w.-]+=\S+/g, (line) => line.replace(/=.*/, '=[REDACTED]'))
  const normalized = next.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3)}...`
}

function sanitizeToolCall(toolCall: MemoryEventToolSummary): MemoryEventToolSummary {
  return {
    name: redact(toolCall.name, 120),
    target: toolCall.target ? redact(toolCall.target, 240) : undefined,
    resultSummary: toolCall.resultSummary ? redact(toolCall.resultSummary, 500) : undefined,
    isError: toolCall.isError,
  }
}

export function sanitizeMemoryEvent(event: MemoryEvent): MemoryEvent {
  return {
    ...event,
    userRequest: redact(event.userRequest, 8_000),
    assistantResult: redact(event.assistantResult, 8_000),
    changedFiles: event.changedFiles?.slice(0, 80).map((file) => redact(file, 400)),
    toolCalls: event.toolCalls?.slice(0, 40).map(sanitizeToolCall),
  }
}
