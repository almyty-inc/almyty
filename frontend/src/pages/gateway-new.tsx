import { useEffect } from 'react'

import { CreateGatewayForm } from '@/components/gateways/create-gateway-form'

/**
 * /gateways/new -- create a gateway: pick its protocol (MCP, UTCP or
 * Skills) and the tools it serves. `?protocol=mcp` opens on one; `?api=`
 * and `?tool=` open with an API or a tool already picked. An agent is put
 * in front of people from its Channels tab, not here.
 */
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
