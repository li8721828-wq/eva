import { Fragment, type ReactNode } from 'react'

export interface ConversationActivityItem {
  id: string
  kind: 'tools' | 'item'
  content: ReactNode
  attachments?: ReactNode
}

/** Each tool batch owns its single disclosure, in transcript order. */
export function ConversationActivity({ items, label, nativeEngine }: {
  items: ConversationActivityItem[]
  label: string
  nativeEngine?: string
}) {
  if (items.length === 0) return null
  return <section className="execution-feed chronological-activity" aria-label={label} data-native-agent={nativeEngine} data-conversation-activity>
    {items.map(item => item.kind === 'tools'
      ? <Fragment key={item.id}>
          <div data-activity-tool-group>{item.content}</div>
          {item.attachments}
        </Fragment>
      : <Fragment key={item.id}>{item.content}</Fragment>)}
  </section>
}
