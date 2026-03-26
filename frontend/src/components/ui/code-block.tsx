import { useState, useEffect, useSyncExternalStore } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import { githubLight } from '@uiw/codemirror-theme-github'

const languageExtensions: Record<string, any> = {
  javascript: javascript(),
  js: javascript(),
  typescript: javascript({ typescript: true }),
  ts: javascript({ typescript: true }),
  json: json(),
  bash: [], // no extension, just plain text with monospace
  shell: [],
  curl: [],
  python: [],
  py: [],
  text: [],
}

interface CodeBlockProps {
  value: string
  language?: string
  copyable?: boolean
  className?: string
  maxHeight?: string
}

function useIsDark() {
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

export function CodeBlock({ value, language, copyable = true, className, maxHeight = '400px' }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const isDark = useIsDark()

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  const ext = language ? languageExtensions[language.toLowerCase()] : []
  const extensions = Array.isArray(ext) ? ext : [ext]

  return (
    <div className={cn('relative group rounded-md border overflow-hidden', className)}>
      {(language || copyable) && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted">
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
      <CodeMirror
        value={value}
        theme={isDark ? oneDark : githubLight}
        extensions={extensions}
        readOnly
        editable={false}
        maxHeight={maxHeight}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          tabSize: 2,
        }}
        className="text-sm"
      />
    </div>
  )
}
