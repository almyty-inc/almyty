import React from 'react'

import { Button } from '@/components/ui/button'

interface TimeframeSelectorProps {
  value: string
  onChange: (v: string) => void
}

export function TimeframeSelector({ value, onChange }: TimeframeSelectorProps) {
  return (
    <div className="flex items-center gap-1 mb-3">
      <span className="text-xs text-muted-foreground mr-1">Timeframe:</span>
      {['1h', '24h', '7d', '30d'].map((tf) => (
        <Button
          key={tf}
          variant={value === tf ? 'default' : 'ghost'}
          size="sm"
          className="h-6 text-xs px-2"
          onClick={() => onChange(tf)}
        >
          {tf}
        </Button>
      ))}
    </div>
  )
}
