export const MODEL_CAPABILITIES = [
  'language',
  'reasoning',
  'code',
  'vision',
  'image',
  'video',
  'embedding',
] as const

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number]

/** A routable model connection. Credentials remain on the referenced provider. */
export interface ModelPoolEntry {
  id: string
  name: string
  providerId: string
  model: string
  capabilities: ModelCapability[]
  priority: number
  enabled: boolean
}

/** An independent model pool that agents can select for capability routing. */
export interface ModelPool {
  id: string
  name: string
  entries: ModelPoolEntry[]
}

export interface ModelRouteRequest {
  poolId?: string
  capability: ModelCapability
  /** Connections in this list are tried in order after the primary match. */
  excludeIds?: string[]
}

export interface ModelRouteResult {
  primary?: ModelPoolEntry
  fallbacks: ModelPoolEntry[]
}
