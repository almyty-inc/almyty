import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

// Two looks over the same Radix keyboard behaviour: `segmented` (default)
// for local, mutually exclusive views, `underline` for page and detail
// navigation. The list tells its triggers which one through context.
type TabsVariant = "segmented" | "underline"
const TabsVariantContext = React.createContext<TabsVariant>("segmented")

const listVariants: Record<TabsVariant, string> = {
  segmented:
    "inline-flex h-10 max-w-full items-center justify-center-safe overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground",
  underline:
    "flex w-full items-end justify-start gap-6 overflow-x-auto border-b text-muted-foreground",
}

// The active segment is the raised surface (white in light, the card
// colour in dark) on the inset track, so it lifts in both themes.
const triggerVariants: Record<TabsVariant, string> = {
  segmented:
    "rounded-md px-3 py-1.5 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-panel",
  underline:
    "-mb-px min-h-11 shrink-0 border-b-2 border-transparent px-0.5 pb-2.5 pt-2 hover:text-foreground data-[state=active]:border-primary data-[state=active]:font-semibold data-[state=active]:text-selection-foreground",
}

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsVariant }
>(({ className, variant = "segmented", ...props }, ref) => (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.List
      ref={ref}
      data-variant={variant}
      className={cn(listVariants[variant], className)}
      {...props}
    />
  </TabsVariantContext.Provider>
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const variant = React.useContext(TabsVariantContext)
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium ring-offset-background transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        triggerVariants[variant],
        className
      )}
      {...props}
    />
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }