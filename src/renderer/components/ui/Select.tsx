import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  value: string
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void
  options: { value: string; label: string; disabled?: boolean }[]
}

interface MenuPosition {
  left: number
  top: number
  width: number
  openUpward: boolean
}

const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  ({ className, value, onChange, options, disabled, onKeyDown, ...props }, forwardedRef) => {
    const triggerRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const [open, setOpen] = useState(false)
    const [position, setPosition] = useState<MenuPosition | null>(null)
    const selected = options.find((option) => option.value === value)

    useImperativeHandle(forwardedRef, () => triggerRef.current as HTMLButtonElement)

    const updatePosition = useCallback(() => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const menuHeight = Math.min(options.length * 36 + 12, 240)
      const openUpward = rect.bottom + menuHeight > window.innerHeight && rect.top > menuHeight
      setPosition({
        left: rect.left,
        top: openUpward ? rect.top - 4 : rect.bottom + 4,
        width: rect.width,
        openUpward,
      })
    }, [options.length])

    useEffect(() => {
      if (!open) return
      updatePosition()
      const closeOnOutsidePress = (event: MouseEvent) => {
        const target = event.target as Node
        if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
          setOpen(false)
        }
      }
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setOpen(false)
          triggerRef.current?.focus()
        }
      }
      window.addEventListener('mousedown', closeOnOutsidePress)
      window.addEventListener('keydown', closeOnEscape)
      window.addEventListener('resize', updatePosition)
      window.addEventListener('scroll', updatePosition, true)
      return () => {
        window.removeEventListener('mousedown', closeOnOutsidePress)
        window.removeEventListener('keydown', closeOnEscape)
        window.removeEventListener('resize', updatePosition)
        window.removeEventListener('scroll', updatePosition, true)
      }
    }, [open, updatePosition])

    const selectOption = (option: SelectProps['options'][number]) => {
      if (option.disabled) return
      onChange?.({ target: { value: option.value } } as React.ChangeEvent<HTMLSelectElement>)
      setOpen(false)
      triggerRef.current?.focus()
    }

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(event)
      if (event.defaultPrevented || disabled) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setOpen((current) => !current)
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setOpen(true)
      }
    }

    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((current) => !current)}
          onKeyDown={handleKeyDown}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1 text-left text-sm text-zinc-900 shadow-sm transition-colors hover:border-zinc-300 focus:outline-none focus-visible:border-zinc-400 focus-visible:shadow-sm disabled:cursor-not-allowed disabled:opacity-50',
            className
          )}
          aria-expanded={open}
          aria-haspopup="listbox"
          {...props}
        >
          <span className="min-w-0 flex-1 truncate">{selected?.label || value}</span>
          <ChevronDown className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform', open && 'rotate-180')} />
        </button>

        {open && position && createPortal(
          <div
            ref={menuRef}
            role="listbox"
            className="fixed z-[100] max-h-60 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 shadow-lg"
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              transform: position.openUpward ? 'translateY(-100%)' : undefined,
            }}
          >
            {options.map((option) => {
              const isSelected = option.value === value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  onClick={() => selectOption(option)}
                  className={cn(
                    'flex min-h-8 w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm transition-colors',
                    isSelected ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-50',
                    option.disabled && 'cursor-not-allowed opacity-45'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                </button>
              )
            })}
          </div>,
          document.body
        )}
      </>
    )
  }
)
Select.displayName = 'Select'

export { Select }
