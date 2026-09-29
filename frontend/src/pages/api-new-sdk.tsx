import { useEffect } from 'react'

import { SdkApiForm } from '@/components/apis/sdk-api-form'

/** `/apis/new/sdk` -- an API made of npm packages. */
export function ApiNewSdkPage() {
  useEffect(() => {
    document.title = 'Connect an API: SDK / npm | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])
  return <SdkApiForm />
}
