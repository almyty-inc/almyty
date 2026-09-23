import { useEffect } from 'react'

import { ToolForm } from '@/components/tools/tool-form'

/** `/tools/new` -- create a tool by hand (`?type=` picks the execution method). */
export function ToolNewPage() {
  useEffect(() => {
    document.title = 'Create tool | almyty'
    return () => { document.title = 'almyty' }
  }, [])
  return <ToolForm />
}
