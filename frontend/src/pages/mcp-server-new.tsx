import { useEffect } from 'react'

import { McpServerForm } from '@/components/tools/mcp-server-form'
import { useOrganizationStore } from '@/store/organization'

/** `/tools/mcp-servers/new` -- register an external MCP server as a tool source. */
export function McpServerNewPage() {
  const { currentOrganization } = useOrganizationStore()
  useEffect(() => {
    document.title = 'Add MCP server | almyty'
    return () => { document.title = 'almyty' }
  }, [])
  return <McpServerForm organizationId={currentOrganization?.id} />
}
