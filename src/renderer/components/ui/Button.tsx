import React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-violet-600 text-white hover:bg-violet-700 shadow-sm',
        ghost: 'hover:bg-zinc-100 text-zinc-600',
        outline: 'border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 shadow-sm',
        destructive: 'bg-red-500 text-white hover:bg-red-600 shadow-sm',
      },
      size: {
        sm: 'h-8 px-3 text-sm rounded-md',
        md: 'h-9 px-4 text-sm rounded-lg',
        lg: 'h-11 px-6 text-base rounded-lg',
        icon: 'h-9 w-9 rounded-lg',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
