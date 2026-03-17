import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface CodeBlockProps {
  value: string
  language?: string
  copyable?: boolean
  className?: string
  maxHeight?: string
}

export function CodeBlock({ value, language, copyable = true, className, maxHeight = '400px' }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={cn('relative group rounded-md border bg-muted/50', className)}>
      {(language || copyable) && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30">
          {language && (
            <span className="text-xs text-muted-foreground font-medium">{language}</span>
          )}
          {copyable && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={handleCopy}
            >
              {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </div>
      )}
      <pre
        className="p-4 text-sm font-mono overflow-auto whitespace-pre-wrap break-words"
        style={{ maxHeight }}
      >
        {value}
      </pre>
    </div>
  )
}
