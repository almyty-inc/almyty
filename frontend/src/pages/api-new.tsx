import { useEffect } from 'react'

import { ApiForm } from '@/components/apis/api-form'

/** `/apis/new` -- step 1 of connecting an API. */
export function ApiNewPage() {
  useEffect(() => {
    document.title = 'Connect API | almyty'
    return () => { document.title = 'almyty' }
  }, [])
  return <ApiForm />
}
