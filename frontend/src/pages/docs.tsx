import { useEffect } from 'react'
import { BookOpen, ExternalLink } from 'lucide-react'

export function DocsPage() {
  useEffect(() => {
    document.title = 'Documentation | apifai'
    return () => { document.title = 'apifai' }
  }, [])

  return (
    <div className="flex flex-col items-center justify-center py-24">
      <BookOpen className="h-12 w-12 text-muted-foreground mb-4" />
      <h1 className="text-2xl font-bold mb-2">Documentation</h1>
      <p className="text-muted-foreground mb-6 max-w-md text-center">
        Complete guides, API reference, and tutorials for apifai.
      </p>
      <a
        href="https://docs.apif.ai"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
      >
        <ExternalLink className="h-4 w-4" />
        Open Documentation
      </a>
      <p className="text-xs text-muted-foreground mt-4">docs.apif.ai</p>
    </div>
  )
}
