/**
 * SchemaTab — read-only viewer for the parsed API schema (OpenAPI/GraphQL/SOAP/gRPC).
 *
 * Renders a controlled dialog that shows the processed/raw schema JSON for
 * the API. Used by the API detail page (`pages/api-detail.tsx`); the parent
 * owns the open state because the trigger lives in the overview info card.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import { Api } from '@/types'

interface SchemaTabProps {
  api: Api
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SchemaTab({ api, open, onOpenChange }: SchemaTabProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Schema Content</DialogTitle>
        </DialogHeader>
        <div className="bg-muted p-4 rounded max-h-[60vh] overflow-y-auto">
          <pre className="text-xs">
            {api.schemas && api.schemas.length > 0 && JSON.stringify(api.schemas[0].processedSchema || api.schemas[0].rawSchema || api.schemas[0].content, null, 2)}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  )
}
