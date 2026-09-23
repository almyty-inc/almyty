import { useEffect } from 'react'
import { BookOpen, ExternalLink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/layout/page-header'

export function DocsPage() {
  useEffect(() => {
    document.title = 'Documentation | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documentation"
        description="Complete guides, API reference, and tutorials for almyty."
      />
      <EmptyState
        variant="panel"
        icon={BookOpen}
        title="The docs live at docs.almyty.com"
        description="Guides, the API reference and tutorials open in a new tab."
        action={
          <Button asChild>
            <a href="https://docs.almyty.com" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              Open documentation
            </a>
          </Button>
        }
      />
    </div>
  )
}