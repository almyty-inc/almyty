import { Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useCopy } from '@/lib/clipboard'

export interface DnsRecord {
  type: string
  name: string
  value: string
}

/**
 * DNS records someone has to publish at their DNS provider, each name and
 * value with its own copy button. Used wherever we prove control of a
 * domain: a hosted chat custom domain, an organization's email domain.
 */
export function DnsRecords({ records }: { records: DnsRecord[] }) {
  const copy = useCopy()
  return (
    <div className="space-y-2" aria-label="DNS records">
      {records.map((record) => (
        <div key={`${record.type}-${record.name}`} className="rounded-md border p-3 text-sm">
          <div className="mb-1 text-xs font-medium text-muted-foreground">{record.type}</div>
          <div className="grid gap-1 sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:items-center">
            <span className="text-muted-foreground">Name</span>
            <code className="break-all font-mono">{record.name}</code>
            <Button type="button" variant="ghost" size="sm" aria-label={`Copy ${record.type} name`} onClick={() => copy(record.name, `${record.type} name`)}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <span className="text-muted-foreground">Value</span>
            <code className="break-all font-mono">{record.value}</code>
            <Button type="button" variant="ghost" size="sm" aria-label={`Copy ${record.type} value`} onClick={() => copy(record.value, `${record.type} value`)}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
