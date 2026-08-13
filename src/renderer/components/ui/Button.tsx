import React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border border-violet-600 bg-violet-600 text-white shadow-sm hover:border-violet-700 hover:bg-violet-700',
        ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900',
        outline: 'border border-zinc-200 bg-white text-zinc-700 shadow-sm hover:border-zinc-300 hover:bg-zinc-50',
        destructive: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
      },
      size: {
        sm: 'h-8 px-3 text-sm rounded-md',
        md: 'h-9 px-4 text-sm rounded-md',
        lg: 'h-11 px-6 text-base rounded-md',
        icon: 'h-9 w-9 rounded-md',
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
