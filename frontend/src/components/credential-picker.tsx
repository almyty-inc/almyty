import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Key } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { SecretInput } from '@/components/ui/secret-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConnectAccountButton, OTHER_SERVICE_KEY } from '@/components/connections/connect-flow'
import { CONNECTIONS_QUERY_KEY } from '@/components/connections/paths'
import { credentialsApi } from '@/lib/api'
import type { VaultCredential } from '@/types'

interface CredentialPickerProps {
  label?: string
  value: string // credentialId or empty for "new"
  onSelect: (credentialId: string) => void
  onNewKey: (key: string) => void
  newKeyValue?: string
  placeholder?: string
  filterType?: string // filter credentials by type
}

/**
 * The key an API or a tool signs in with: paste one, or pick a key saved
 * on Connections. "Save a new key" opens the same inline connect form the
 * Connections page uses, so a key saved here is a connection like any other.
 */
export function CredentialPicker({
  label = 'API key',
  value,
  onSelect,
  onNewKey,
  newKeyValue = '',
  placeholder = 'Paste the key',
  filterType,
}: CredentialPickerProps) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'saved' | 'paste'>(value ? 'saved' : 'paste')

  const { data: credentialsRaw } = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.getAll(),
  })
  const credentials: VaultCredential[] = (
    Array.isArray(credentialsRaw) ? credentialsRaw : (credentialsRaw as any)?.credentials || []
  ).filter((c: any) => !filterType || c.type === filterType || c._source === 'llm_provider')

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setMode(mode === 'saved' ? 'paste' : 'saved')}
        >
          {mode === 'saved' ? 'Paste a key instead' : 'Use a saved key'}
        </button>
      </div>

      {mode === 'saved' ? (
        <div className="space-y-2">
          <Select value={value} onValueChange={onSelect}>
            <SelectTrigger aria-label={label}>
              <SelectValue placeholder="Pick a saved key" />
            </SelectTrigger>
            <SelectContent>
              {credentials.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">No saved keys yet</div>
              )}
              {credentials.map((cred) => (
                <SelectItem key={cred.id} value={cred.id}>
                  <div className="flex items-center gap-2">
                    <Key className="h-3 w-3 text-muted-foreground" aria-hidden />
                    <span>{cred.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ConnectAccountButton
            connectorKey={OTHER_SERVICE_KEY}
            label="Save a new key"
            variant="ghost"
            onConnected={(connection) => {
              queryClient.invalidateQueries({ queryKey: ['credentials'] })
              queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
              onSelect(connection.id)
            }}
          />
        </div>
      ) : (
        <SecretInput value={newKeyValue} onChange={(e) => onNewKey(e.target.value)} placeholder={placeholder} aria-label={label} />
      )}
    </div>
  )
}
