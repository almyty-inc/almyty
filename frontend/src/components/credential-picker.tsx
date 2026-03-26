import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Key, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
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

export function CredentialPicker({
  label = 'API Key',
  value,
  onSelect,
  onNewKey,
  newKeyValue = '',
  placeholder = 'Enter your API key',
  filterType,
}: CredentialPickerProps) {
  const [mode, setMode] = useState<'select' | 'new'>(value ? 'select' : 'new')

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
          onClick={() => setMode(mode === 'select' ? 'new' : 'select')}
        >
          {mode === 'select' ? '+ Enter new key' : 'Use existing secret'}
        </button>
      </div>

      {mode === 'select' ? (
        <Select value={value} onValueChange={onSelect}>
          <SelectTrigger>
            <SelectValue placeholder="Select a secret from vault..." />
          </SelectTrigger>
          <SelectContent>
            {credentials.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">No secrets in vault</div>
            )}
            {credentials.map((cred) => (
              <SelectItem key={cred.id} value={cred.id}>
                <div className="flex items-center gap-2">
                  <Key className="h-3 w-3 text-muted-foreground" />
                  <span>{cred.name}</span>
                  <Badge variant="outline" className="text-[10px] ml-1">{cred.type}</Badge>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          type="password"
          value={newKeyValue}
          onChange={(e) => onNewKey(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </div>
  )
}
