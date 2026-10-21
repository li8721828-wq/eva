import React from 'react'
import { cn } from '@/lib/utils'

/** Native checkbox interaction, presented consistently for on/off preferences. */
export const Switch = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>>(
  ({ className, ...props }, ref) => <span className={cn('eva-switch', className)}>
    <input {...props} ref={ref} type="checkbox" role="switch" />
    <span className="eva-switch__track" aria-hidden="true" />
  </span>
)
Switch.displayName = 'Switch'
