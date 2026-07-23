import React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-100 disabled:cursor-not-allowed disabled:opacity-50 shadow-sm',
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
