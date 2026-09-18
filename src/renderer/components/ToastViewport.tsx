import { useEffect } from 'react'
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToastStore, type ToastEntry, type ToastKind } from '@/stores/use-toast-store'

/**
 * Floating notification viewport. Mount once near the app root. Each toast
 * animates in from the bottom-right, lives for its `durationMs`, then exits
 * with a 180ms fade so rapid pushes do not feel jumpy.
 *
 * Action buttons render inside the card and call `dismiss` themselves; the
 * card itself is non-blocking except when `dismissable: false` (used for
 * critical confirmations).
 */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-[100] flex w-[min(22rem,calc(100vw-3rem))] flex-col items-end gap-2"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  )
}

function ToastCard({ toast, onDismiss }: { toast: ToastEntry; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.durationMs <= 0 || !toast.dismissable) return
    const timer = window.setTimeout(onDismiss, toast.durationMs)
    return () => window.clearTimeout(timer)
  }, [toast.durationMs, toast.dismissable, onDismiss])

  const Icon = TOAST_ICONS[toast.kind]
  const tint = TOAST_TINT[toast.kind]

  return (
    <div
      className={cn(
        'pointer-events-auto flex w-full items-start gap-3 rounded-xl border bg-white/96 px-3.5 py-3 shadow-[0_18px_38px_-22px_rgba(15,23,42,0.45),0_4px_10px_-6px_rgba(15,23,42,0.18)] backdrop-blur-md transition-all duration-200',
        tint,
      )}
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TOAST_ICON_TINT[toast.kind])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-5 text-zinc-800">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 break-words text-xs leading-5 text-zinc-600">{toast.description}</p>
        ) : null}
        {toast.actions && toast.actions.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {toast.actions.map((action, index) => (
              <button
                key={`${action.label}-${index}`}
                type="button"
                onClick={() => {
                  action.onClick()
                  onDismiss()
                }}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                  action.variant === 'primary'
                    ? 'bg-violet-600 text-white hover:bg-violet-700'
                    : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50',
                )}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {toast.dismissable ? (
        <button
          type="button"
          onClick={onDismiss}
          className="-mr-1 -mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
          aria-label="Dismiss notification"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}

const TOAST_ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
}

const TOAST_TINT: Record<ToastKind, string> = {
  info: 'border-sky-200/85',
  success: 'border-emerald-200/85',
  warning: 'border-amber-200/85',
  error: 'border-rose-200/85',
}

const TOAST_ICON_TINT: Record<ToastKind, string> = {
  info: 'text-sky-600',
  success: 'text-emerald-600',
  warning: 'text-amber-600',
  error: 'text-rose-600',
}
