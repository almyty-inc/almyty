/* CopyField -- a read-only value the user has to paste somewhere else
 * (a webhook callback URL into Meta's console, a gateway endpoint into a
 * client config), with a copy button next to it.
 *
 * The value stays selectable text, so a user whose clipboard API is
 * blocked can still select it by hand.
 */
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useCopy } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

export function CopyField({
  id,
  value,
  label,
  className,
}: {
  id?: string
  value: string
  /** What the toast calls the value ("Callback URL copied"). */
  label: string
  className?: string
}) {
  const copy = useCopy()
  const [copied, setCopied] = useState(false)
  return (
    <div className={cn('flex min-w-0 items-stretch gap-2', className)}>
      <code
        id={id}
        className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap rounded-lg border bg-muted px-3 py-2 font-mono text-xs"
        data-testid="copy-field-value"
      >
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={async () => {
          await copy(value, label)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  )
}
