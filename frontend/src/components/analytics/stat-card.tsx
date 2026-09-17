import React from 'react'

import { cn } from '@/lib/utils'

interface StatCardProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  className?: string
}

export function StatCard({ icon: Icon, label, value, className }: StatCardProps) {
  return (
    // rounded-xl, not rounded-lg: the house card radius is set once in
    // components/ui/card.tsx and this tile sits in the same grid as
    // <Card>s, so a smaller radius read as a different component.
    <div className={cn('rounded-xl border bg-card p-4', className)}>
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <Icon className="h-4 w-4" />
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  )
}
