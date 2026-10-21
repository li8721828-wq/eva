import React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'eva-input eva-focus-float flex h-9 w-full rounded-md border border-[var(--ui-border-strong)] bg-[var(--bg-input)] px-3 py-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
