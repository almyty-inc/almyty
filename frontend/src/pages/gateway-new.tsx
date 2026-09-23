import { useEffect } from 'react'

import { CreateGatewayForm } from '@/components/gateways/create-gateway-form'

/** /gateways/new -- create a gateway. */
export function GatewayNewPage() {
  useEffect(() => {
    document.title = 'Create gateway | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])
  return <CreateGatewayForm />
}

export default GatewayNewPage
