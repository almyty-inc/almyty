import * as React from "react"

import { cn } from "@/lib/utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-lg border border-input bg-field px-3 py-2 text-sm ring-offset-background transition-colors duration-[120ms] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-[color:var(--am-text-placeholder)] hover:bg-field-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 read-only:bg-[var(--am-field-read-only)] disabled:cursor-not-allowed disabled:bg-[var(--am-field-disabled)] disabled:opacity-70 aria-[invalid=true]:border-destructive pointer-coarse:h-11",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }