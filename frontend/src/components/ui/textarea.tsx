import * as React from "react"

import { cn } from "@/lib/utils"

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-lg border border-input bg-field px-3 py-2 text-sm ring-offset-background transition-colors duration-[120ms] placeholder:text-[color:var(--am-text-placeholder)] hover:bg-field-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 read-only:bg-[var(--am-field-read-only)] disabled:cursor-not-allowed disabled:bg-[var(--am-field-disabled)] disabled:opacity-70 aria-[invalid=true]:border-destructive",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }