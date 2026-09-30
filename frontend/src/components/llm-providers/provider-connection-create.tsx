/**
 * Adding a provider connection, from the first click to its models:
 *
 *   1. pick the provider from the shared tiles,
 *   2. name the connection and give it a key (Ollama: an Ollama Cloud key,
 *      or the URL of a server you run); saving checks the key,
 *   3. see the models the key reaches, all ticked, and untick any you do
 *      not want offered.
 *
 * One component for every place a connection is made: the connect page,
 * the provider group on Credentials, and "Add a connection" inside a model
 * chooser. Nothing opens in a dialog; the steps replace each other in
 * place, and `onDone` hands back the new connection.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'

import { PickedService, ServiceTileGrid, splitTileName, type ServiceTileGroup } from '@/components/connect/service-tiles'
import { ConnectProviderForm, type ConnectResult } from './connect-provider-form'
import { AllowedModelsEditor } from './allowed-models-editor'
import { PROVIDER_TILE_GROUPS, isProviderType, providerTileLabel } from './provider-catalog'
import { providerLogos } from './provider-type-config'
import { pluralized } from '@/lib/utils'

export interface ProviderConnectionCreateProps {
  /** The picked provider; null or absent shows the tiles. Pass with onTypeChange to keep it in the URL. */
  type?: string | null
  onTypeChange?: (type: string | null) => void
  /** The new connection, once its models are chosen. */
  onDone: (provider: ConnectResult['provider']) => void
  /** Present = a Cancel button on the form (inline use). */
  onCancel?: () => void
  /** Prefix for element ids and test ids, so two of these on one screen stay distinct. */
  idPrefix?: string
  /** Shown under the tiles when the search matches nothing. */
  emptySearch?: ReactNode
}

export function ProviderConnectionCreate({ type: controlledType, onTypeChange, onDone, onCancel, idPrefix = 'connect', emptySearch }: ProviderConnectionCreateProps) {
  const queryClient = useQueryClient()
  const [ownType, setOwnType] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<ConnectResult | null>(null)
  const picked = controlledType !== undefined ? controlledType : ownType
  const type = isProviderType(picked) ? picked : null

  const pick = (next: string | null) => {
    setResult(null)
    if (onTypeChange) onTypeChange(next)
    else setOwnType(next)
  }

  const groups: ServiceTileGroup[] = useMemo(() => {
    const q = search.trim().toLowerCase()
    return PROVIDER_TILE_GROUPS.map((g) => ({
      id: g.id,
      title: g.title,
      tiles: g.types
        .filter((t) => !q || providerTileLabel(t).toLowerCase().includes(q) || t.includes(q))
        .map((t) => ({ key: t, ...splitTileName(providerTileLabel(t)), icon: providerLogos[t] || '⚙️' })),
    })).filter((g) => g.tiles.length > 0)
  }, [search])

  const onConnected = (next: ConnectResult) => {
    setResult(next)
    // The new connection and its models, everywhere they are listed.
    queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
    queryClient.invalidateQueries({ queryKey: ['credentials'] })
  }

  if (!type) {
    return (
      <ServiceTileGrid
        groups={groups}
        search={search}
        onSearch={setSearch}
        onPick={pick}
        searchLabel="Search providers"
        testIdPrefix={idPrefix === 'connect' ? 'provider-tile' : `${idPrefix}-tile`}
        empty={
          emptySearch ?? (
            <p className="text-sm text-muted-foreground">
              No provider matches &ldquo;{search}&rdquo;. If it speaks the OpenAI API, connect it as{' '}
              <button type="button" className="text-primary hover:underline" onClick={() => pick('custom')}>
                your own server
              </button>
              .
            </p>
          )
        }
      />
    )
  }

  const models = Array.isArray(result?.models) ? result!.models : []
  return (
    <PickedService icon={providerLogos[type] || '⚙️'} title={providerTileLabel(type)} onChooseAnother={result ? undefined : () => pick(null)} chooseAnotherLabel="Choose another provider">
      {result ? (
        <div className="space-y-4" data-testid={`${idPrefix}-success`}>
          <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {result.provider.name} is connected. {models.length === 0 ? 'It lists no models yet.' : `${pluralized(models.length, 'model')} found, all ticked.`}
          </p>
          {models.length > 0 && <p className="text-sm text-muted-foreground">Untick any model you do not want offered in model choosers. You can change this later on the connection.</p>}
          <AllowedModelsEditor
            provider={result.provider as any}
            cards={models}
            submitLabel="Done"
            alwaysSubmittable
            onSaved={(saved) => {
              queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
              queryClient.invalidateQueries({ queryKey: ['models'] })
              onDone({ ...result.provider, ...(saved && typeof saved === 'object' ? saved : {}) })
            }}
          />
        </div>
      ) : (
        <ConnectProviderForm key={type} type={type} onConnected={onConnected} onCancel={onCancel} idPrefix={idPrefix} />
      )}
    </PickedService>
  )
}
