import React, { useState, createContext, useContext, useCallback, useRef } from 'react'
import { cn } from '@/lib/utils'

interface TabsContextValue {
  value: string
  onChange: (value: string) => void
  baseId: string
}

const TabsContext = createContext<TabsContextValue>({ value: '', onChange: () => {}, baseId: 'tabs' })

let tabsCounter = 0

export interface TabsProps {
  defaultValue?: string
  value?: string
  onValueChange?: (value: string) => void
  children: React.ReactNode
  className?: string
}

function Tabs({ defaultValue, value, onValueChange, children, className }: TabsProps) {
  const [internalValue, setInternalValue] = useState(defaultValue || '')
  const currentValue = value !== undefined ? value : internalValue
  const baseIdRef = useRef(`tabs-${++tabsCounter}`)

  const handleChange = (val: string) => {
    if (value === undefined) setInternalValue(val)
    onValueChange?.(val)
  }

  return (
    <TabsContext.Provider value={{ value: currentValue, onChange: handleChange, baseId: baseIdRef.current }}>
      <div className={cn('flex flex-col', className)}>{children}</div>
    </TabsContext.Provider>
  )
}

export interface TabsListProps {
  children: React.ReactNode
  className?: string
}

function TabsList({ children, className }: TabsListProps) {
  const listRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tabs = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
    if (!tabs || tabs.length === 0) return

    const currentIndex = Array.from(tabs).indexOf(document.activeElement as HTMLElement)
    let nextIndex = currentIndex

    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % tabs.length
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = tabs.length - 1
    } else {
      return
    }

    e.preventDefault()
    tabs[nextIndex]?.focus()
  }, [])

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
      className={cn('flex gap-1 border-b border-zinc-200 px-1', className)}
    >
      {children}
    </div>
  )
}

export interface TabsTriggerProps {
  value: string
  children: React.ReactNode
  className?: string
}

function TabsTrigger({ value, children, className }: TabsTriggerProps) {
  const { value: currentValue, onChange, baseId } = useContext(TabsContext)
  const isActive = value === currentValue
  const triggerId = `${baseId}-trigger-${value}`

  return (
    <button
      id={triggerId}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      aria-controls={`${baseId}-panel-${value}`}
      className={cn(
        'px-4 py-2.5 text-sm font-medium transition-all duration-200 border-b-2 -mb-px',
        isActive
          ? 'border-violet-600 text-violet-600'
          : 'border-transparent text-zinc-500 hover:text-zinc-700',
        className
      )}
      onClick={() => onChange(value)}
    >
      {children}
    </button>
  )
}

export interface TabsContentProps {
  value: string
  children: React.ReactNode
  className?: string
}

function TabsContent({ value, children, className }: TabsContentProps) {
  const { value: currentValue, baseId } = useContext(TabsContext)
  const isActive = value === currentValue
  if (!isActive) return null
  return (
    <div
      id={`${baseId}-panel-${value}`}
      role="tabpanel"
      aria-labelledby={`${baseId}-trigger-${value}`}
      className={cn('py-3', className)}
    >
      {children}
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
