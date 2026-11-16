import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Display-only: no hover state. Tones are the semantic status pairs from
// the design tokens (info, success, warning, danger, neutral); pair them
// with a label or icon, never colour alone. Tailwind colour classes rather
// than the tone-* utilities so a className override merges cleanly.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-info-subtle text-info",
        info: "border-transparent bg-info-subtle text-info",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        neutral: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-danger-subtle text-danger",
        outline: "text-foreground",
        success: "border-transparent bg-success-subtle text-success",
        warning: "border-transparent bg-warning-subtle text-warning",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }