import { useEffect } from 'react'

import { PageHeader } from '@/components/layout/page-header'
import { ShortcutList } from '@/components/keyboard-shortcuts'

export function ShortcutsPage() {
  useEffect(() => {
    document.title = 'Keyboard shortcuts | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Keyboard shortcuts"
        description={
          <>
            Press <kbd className="rounded border px-1.5 py-0.5 font-mono text-xs">?</kbd> anywhere
            outside a text field to come back here.
          </>
        }
      />
      <ShortcutList />
    </div>
  )
}
