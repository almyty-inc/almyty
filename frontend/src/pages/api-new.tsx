import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Cloud, Database, Globe, Package, Server, Webhook } from 'lucide-react'

import { FormPage } from '@/components/layout/form-page'
import { ChoiceTile, ChoiceTiles } from '@/components/connect/service-tiles'
import { API_KIND_TILES } from '@/components/apis/api-types'
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
 * a plain HTTP API.
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
    <FormPage title="Connect an API" description="Pick what kind of API it is." back={{ to: '/apis', label: 'APIs' }} width="wide">
      <ChoiceTiles label="Kind of API">
        {API_KIND_TILES.map((tile) => {
          const Icon = TILE_ICONS[tile.key]
          return <ChoiceTile key={tile.key} testId={`api-kind-${tile.key}`} icon={<Icon className="h-4 w-4 text-primary" />} label={tile.label} hint={tile.hint} onClick={() => navigate(tile.to)} />
        })}
      </ChoiceTiles>
      <p className="text-sm text-muted-foreground" data-testid="other-ways">
        Want a single call instead?{' '}
        <Link to="/tools/new" className="text-primary hover:underline">
          Create a tool
        </Link>
      </p>
    </FormPage>
  )
}
