import { EmptyState, Button } from 'almyty-frontend'
import { Network, Plus } from 'lucide-react'

export const Default = () => (
  <div style={{ width: 560 }}>
    <EmptyState
      icon={Network}
      title="No gateways yet"
      description="Create a gateway to expose your tools over MCP, A2A, UTCP, or Skills."
      action={
        <Button>
          <Plus className="mr-2 h-4 w-4" /> New gateway
        </Button>
      }
      secondaryAction={<Button variant="outline">Read the docs</Button>}
    />
  </div>
)

export const TitleOnly = () => (
  <div style={{ width: 560 }}>
    <EmptyState title="No results" description="Try adjusting your filters." />
  </div>
)
