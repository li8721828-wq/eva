import React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border border-violet-500/50 bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600 text-white shadow-[0_8px_18px_-10px_rgba(79,70,229,0.85)] hover:-translate-y-px hover:from-violet-700 hover:via-indigo-700 hover:to-blue-700 hover:shadow-[0_12px_24px_-12px_rgba(79,70,229,0.9)]',
        ghost: 'text-zinc-600 hover:bg-violet-50/75 hover:text-violet-800',
        outline: 'border border-indigo-100/90 bg-white/75 text-zinc-700 shadow-[0_4px_12px_-10px_rgba(45,55,100,0.45)] backdrop-blur-sm hover:-translate-y-px hover:border-violet-200 hover:bg-violet-50/60 hover:text-violet-800',
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
