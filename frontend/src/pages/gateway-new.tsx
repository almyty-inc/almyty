import { useEffect } from 'react'

import { ShareToolsForm } from '@/components/gateways/share-tools-form'

/**
 * /gateways/new -- share tools. Tools are the only thing made here: an
 * agent is put in front of people from its app (/apps).
 */
export function GatewayNewPage() {
  useEffect(() => {
    document.title = 'Share tools | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])
  return <ShareToolsForm />
}

export default GatewayNewPage
