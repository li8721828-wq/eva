import React from 'react'
import { cn } from '@/lib/utils'

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: { value: string; label: string; disabled?: boolean }[]
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, ...props }, ref) => {
    return (
      <select
        className={cn(
          'flex h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-900 focus-visible:outline-none focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-100 disabled:cursor-not-allowed disabled:opacity-50 shadow-sm',
          className
        )}
        ref={ref}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
    )
  }
)
Select.displayName = 'Select'

export { Select }
