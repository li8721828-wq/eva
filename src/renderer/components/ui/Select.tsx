import React, { useCallback, useEffect, useImperativeHandle, useRef, useState, useContext, useId, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { FloatingDepth, focusableElements, registerFloatingLayer } from '@/lib/floating-layer'
import { cn } from '@/lib/utils'

export interface SelectProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  value: string
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void
  options: { value: string; label: string; disabled?: boolean }[]
  menuClassName?: string
  optionClassName?: string
  selectedOptionClassName?: string
  triggerIcon?: React.ReactNode
  /** Fixed menu width in px. The menu then anchors its right edge to the trigger, because a narrow icon trigger has no width worth matching. */
  menuWidth?: number
}

interface MenuPosition {
  left: number
  top: number
  width: number
  maxHeight: number
}

const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  ({ className, value, onChange, options, disabled, onKeyDown, menuClassName, optionClassName, selectedOptionClassName, triggerIcon, menuWidth, ...props }, forwardedRef) => {
    const triggerRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const depth = useContext(FloatingDepth) + 1
    const menuId = useId()
    const [activeIndex, setActiveIndex] = useState(0)
    const [open, setOpen] = useState(false)
    const [position, setPosition] = useState<MenuPosition | null>(null)
    const selected = options.find((option) => option.value === value)

    useImperativeHandle(forwardedRef, () => triggerRef.current as HTMLButtonElement)

    const updatePosition = useCallback(() => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const gap = 8
      const below = Math.max(0, window.innerHeight - rect.bottom - gap)
      const above = Math.max(0, rect.top - gap)
      const desiredHeight = Math.min(menuRef.current?.scrollHeight || options.length * 36 + 8, 240)
      const upward = below < desiredHeight && above > below
      const maxHeight = Math.min(240, upward ? above : below)
      const width = Math.min(menuWidth ?? rect.width, window.innerWidth - gap * 2)
      setPosition({
        left: Math.max(gap, Math.min(menuWidth ? rect.right - width : rect.left, window.innerWidth - width - gap)),
        top: upward ? Math.max(gap, rect.top - Math.min(desiredHeight, maxHeight) - 4) : rect.bottom + 4,
        width, maxHeight,
      })
    }, [options.length, menuWidth])

    useLayoutEffect(() => { if (open) updatePosition() }, [open, position !== null, updatePosition])
    useLayoutEffect(() => {
      if (!open || !menuRef.current) return
      const unregister = registerFloatingLayer({
        element: menuRef.current, trigger: triggerRef.current, depth,
        dismiss: () => { setOpen(false); triggerRef.current?.focus() },
      })
      window.addEventListener('resize', updatePosition)
      window.addEventListener('scroll', updatePosition, true)
      return () => {
        unregister()
        window.removeEventListener('resize', updatePosition)
        window.removeEventListener('scroll', updatePosition, true)
      }
    }, [open, position !== null, depth, updatePosition])
    useLayoutEffect(() => {
      if (!open) return
      const item = menuRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ;(item ?? menuRef.current)?.focus()
      item?.scrollIntoView({ block: 'nearest' })
    }, [open, activeIndex, position !== null])
    useEffect(() => { if (disabled) setOpen(false) }, [disabled])
    const openMenu = (last = false) => {
      const selectedIndex = options.findIndex(option => option.value === value && !option.disabled)
      const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : (last ? enabled.at(-1) : enabled[0]) ?? -1)
      setOpen(true)
    }
    const handleMenuKeyDown = (event: React.KeyboardEvent) => {
      const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const current = enabled.indexOf(activeIndex)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
          : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length
        setActiveIndex(enabled[index] ?? -1)
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const option = options[activeIndex]
        if (option) selectOption(option)
      } else if (event.key === 'Tab') {
        event.preventDefault()
        setOpen(false)
        const trigger = triggerRef.current
        if (!trigger) return
        const items = focusableElements(trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body)
          .filter(item => !item.closest('[role="listbox"]'))
        const index = items.indexOf(trigger)
        ;(items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length] ?? trigger).focus()
      }
    }

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
        open ? setOpen(false) : openMenu()
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        openMenu(event.key === 'ArrowUp')
      }
    }

    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => { if (!disabled) { if (open) setOpen(false); else openMenu() } }}
          onKeyDown={handleKeyDown}
          className={cn(
            'eva-focus-float flex h-9 w-full items-center justify-between gap-2 rounded-md border border-[var(--ui-border-strong)] bg-[var(--bg-input)] px-3 py-1 text-left text-sm text-[var(--text-primary)] transition-[border-color,box-shadow] hover:border-zinc-300 hover:bg-zinc-50 focus:outline-none focus-visible:border-transparent focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50',
            triggerIcon && 'justify-center px-0',
            className
          )}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? menuId : undefined}
          {...props}
        >
          {triggerIcon || (
            <>
              <span className="min-w-0 flex-1 truncate">{selected?.label || value}</span>
              <ChevronDown className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform', open && 'rotate-180')} />
            </>
          )}
        </button>

        {open && position && createPortal(
          <div
            ref={menuRef}
            role="listbox"
            id={menuId}
            aria-label={props['aria-label'] ?? selected?.label ?? value}
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
            className={cn(
              'fixed z-[100] max-h-60 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 shadow-lg',
              menuClassName
            )}
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.maxHeight,
              zIndex: 100 + depth * 20,
            }}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-index={index}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onFocus={() => setActiveIndex(index)}
                  disabled={option.disabled}
                  onClick={() => selectOption(option)}
                  className={cn(
                    'flex min-h-8 w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm transition-colors',
                    isSelected ? cn('bg-violet-50/80 text-zinc-900', selectedOptionClassName) : cn('text-zinc-700 hover:bg-zinc-50/90', optionClassName),
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
