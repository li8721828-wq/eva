import React, { createContext, useContext, useLayoutEffect, useId, useRef } from 'react'
import { FloatingDepth, focusableElements, registerFloatingLayer } from '@/lib/floating-layer'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'
import { useAppStore } from '@/stores/use-app-store'
import { shellCopy } from '@/lib/shell-copy'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  className?: string
}

const DialogTitleId = createContext('')

function Dialog({ open, onOpenChange, children, className }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const depth = useContext(FloatingDepth) + 1
  const onChangeRef = useRef(onOpenChange)
  onChangeRef.current = onOpenChange
  useLayoutEffect(() => {
    if (!open || !dialogRef.current) return
    const previousFocus = document.activeElement as HTMLElement | null
    const unregister = registerFloatingLayer({
      element: dialogRef.current, depth, modal: true,
      dismiss: () => onChangeRef.current(false),
    })
    ;(focusableElements(dialogRef.current)[0] ?? dialogRef.current).focus()
    return () => {
      unregister()
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [open, depth])

  if (!open) return null

  // Portaled to <body> on purpose: a transformed ancestor (.eva-lift:hover, .agent-card) would
  // otherwise become the containing block of this fixed wrapper and swallow the dim overlay.
  return createPortal(
    <FloatingDepth.Provider value={depth}><DialogTitleId.Provider value={titleId}>
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: 100 + depth * 20 }}>
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn('relative z-50 w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-6 shadow-xl', className)}
      >
        {children}
      </div>
    </div>
    </DialogTitleId.Provider></FloatingDepth.Provider>,
    document.body
  )
}

export interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}
function DialogHeader({ className, ...props }: DialogHeaderProps) {
  return <div className={cn('flex flex-col gap-1.5 mb-4', className)} {...props} />
}

export interface DialogTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}
function DialogTitle({ className, id, ...props }: DialogTitleProps) {
  const titleId = useContext(DialogTitleId)
  return <h2 id={id ?? titleId} className={cn('text-lg font-semibold text-zinc-900', className)} {...props} />
}

export interface DialogDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {}
function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return <p className={cn('text-sm text-zinc-500', className)} {...props} />
}

export interface DialogCloseProps {
  onClose: () => void
}
function DialogClose({ onClose }: DialogCloseProps) {
  const language = useAppStore(state => state.language)
  return (
    <button
      onClick={onClose}
      aria-label={shellCopy[language].close}
      className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md opacity-70 hover:opacity-100 text-zinc-400 hover:text-zinc-600 transition-colors"
    >
      <X className="h-4 w-4" />
    </button>
  )
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogClose }
