import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Cloud, Database, Globe, Package, Server, Webhook } from 'lucide-react'

import { FormPage } from '@/components/layout/form-page'
import { PickList } from '@/components/ui/option-list'
import { API_KIND_TILES } from '@/components/apis/api-types'
import { PROVIDER_APIS, providerApiPath } from '@/components/apis/provider-apis'
import { BrandIcon } from '@/components/brand-icon'
import type { ConnectApiResult } from '@/types/api-connect'

/** Where "Finish connecting" picks up: the import job, and what is still needed. */
export function setupPath(result: ConnectApiResult): string {
  const params = new URLSearchParams({ job: String(result.jobId) })
  if (result.needs.key) params.set('key', '1')
  if (result.needs.address) params.set('address', '1')
  return `/apis/${result.api.id}/setup?${params.toString()}`
}

/** The same icons the APIs list shows for each kind. */
const TILE_ICONS = {
  openapi: Globe,
  graphql: Database,
  soap: Cloud,
  grpc: Server,
  sdk: Package,
  http: Webhook,
} as const

/**
 * `/apis/new`: connect an API. First say what kind it is; each kind opens
 * its own form, asking for the description the way that kind comes (a
 * link, a file or the text), the packages of an npm SDK, or the address of
 * a plain HTTP API. Or pick a model provider's own API, ready-made: its
 * published description, called with the key already kept for it.
 */
export function ApiNewPage() {
  const navigate = useNavigate()

  useEffect(() => {
    document.title = 'Connect an API | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  return (
    <FormPage title="Connect an API" description="Pick what kind of API it is." back={{ to: '/apis', label: 'APIs' }}>
      <PickList
        label="Kind of API"
        items={API_KIND_TILES.map((tile) => {
          const Icon = TILE_ICONS[tile.key]
          return {
            key: tile.key,
            testId: `api-kind-${tile.key}`,
            icon: <Icon className="text-primary" />,
            label: tile.label,
            hint: tile.hint,
            onPick: () => navigate(tile.to),
          }
        })}
      />
      <section className="space-y-2" aria-labelledby="provider-apis-heading">
        <h2 id="provider-apis-heading" className="text-sm font-semibold">
          Ready-made provider APIs
        </h2>
        <PickList
          label="Ready-made provider APIs"
          items={PROVIDER_APIS.map((p) => ({
            key: p.key,
            testId: `provider-api-${p.key}`,
            icon: <BrandIcon brand={p.key} name={p.label} />,
            label: p.label,
            hint: p.hint,
            onPick: () => navigate(providerApiPath(p.key)),
          }))}
        />
      </section>
      <p className="text-sm text-muted-foreground" data-testid="other-ways">
        Want a single call instead?{' '}
        <Link to="/tools/new" className="text-primary hover:underline">
          Create a tool
        </Link>
      </p>
    </FormPage>
  )
}
