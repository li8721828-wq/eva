import React, { useEffect, useCallback, useRef } from 'react'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  className?: string
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function Dialog({ open, onOpenChange, children, className }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    },
    [onOpenChange]
  )

  // Focus trap: Tab cycles within dialog
  const handleTab = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !dialogRef.current) return

      const focusableEls = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusableEls.length === 0) return

      const first = focusableEls[0]
      const last = focusableEls[focusableEls.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    },
    []
  )

  // On open: save previous focus, focus first focusable element
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null
      // Defer to next tick so DOM is ready
      requestAnimationFrame(() => {
        if (dialogRef.current) {
          const first = dialogRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
          first?.focus()
        }
      })
    } else {
      // Restore focus on close
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      handleEscape(e)
      handleTab(e)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, handleEscape, handleTab])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/30" onClick={() => onOpenChange(false)} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={cn('relative z-50 w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl', className)}
      >
        {children}
      </div>
    </div>
  )
}

export interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}
function DialogHeader({ className, ...props }: DialogHeaderProps) {
  return <div className={cn('flex flex-col gap-1.5 mb-4', className)} {...props} />
}

export interface DialogTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}
function DialogTitle({ className, id, ...props }: DialogTitleProps) {
  return <h2 id={id ?? 'dialog-title'} className={cn('text-lg font-semibold text-zinc-900', className)} {...props} />
}

export interface DialogDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {}
function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return <p className={cn('text-sm text-zinc-500', className)} {...props} />
}

export interface DialogCloseProps {
  onClose: () => void
}
function DialogClose({ onClose }: DialogCloseProps) {
  return (
    <button
      onClick={onClose}
      aria-label="Close dialog"
      className="absolute right-4 top-4 p-1 rounded-md opacity-70 hover:opacity-100 text-zinc-400 hover:text-zinc-600 transition-colors"
    >
      <X className="h-4 w-4" />
    </button>
  )
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogClose }
