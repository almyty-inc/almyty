/**
 * The person's time zone, used for when their emails arrive (the daily
 * model digest goes out at 08:00 in it). Unset means UTC.
 */
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export const DEFAULT_TIME_ZONE = 'UTC'

/** Every IANA zone the browser knows, UTC first; a short list when it knows none. */
export function timeZones(): string[] {
  let zones: string[] = []
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    zones = intl.supportedValuesOf?.('timeZone') ?? []
  } catch {
    zones = []
  }
  if (zones.length === 0) zones = ['Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']
  return [DEFAULT_TIME_ZONE, ...zones.filter((z) => z !== DEFAULT_TIME_ZONE)]
}

/** The browser's own zone, when it says. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

export function TimeZoneSelect({ id, value, onChange }: { id: string; value: string | null; onChange: (zone: string) => void }) {
  const zones = useMemo(() => timeZones(), [])
  const current = value || DEFAULT_TIME_ZONE
  const mine = browserTimeZone()
  const options = zones.includes(current) ? zones : [current, ...zones]
  return (
    <div className="space-y-1.5">
      <Select value={current} onValueChange={onChange}>
        <SelectTrigger id={id} className="mt-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {options.map((zone) => (
            <SelectItem key={zone} value={zone}>
              {zone.replace(/_/g, ' ')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mine && mine !== current && (
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onChange(mine)}>
          Use my time zone ({mine.replace(/_/g, ' ')})
        </Button>
      )}
    </div>
  )
}
