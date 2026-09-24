import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useCopy } from '@/lib/clipboard'

/**
 * The URLs an organization registers at its identity provider for
 * hosted-chat SSO visitor sign-in, shown where that sign-in is chosen.
 * They come from the API, which builds them with the same functions the
 * sign-in routes use; nothing here assembles a URL.
 */
export interface HostedChatSsoUrlsState {
  protocol: 'saml' | 'oidc' | null
  samlAcsUrls: string[]
  oidcRedirectUri: string | null
}

function UrlRow({ url, label }: { url: string; label: string }) {
  const copy = useCopy()
  return (
    <div className="flex items-center gap-2 rounded-md border p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{url}</code>
      <Button type="button" variant="ghost" size="sm" aria-label={`Copy ${url}`} onClick={() => copy(url, label)}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

export function HostedChatSsoUrls({ gatewayId, savedSlug }: { gatewayId: string; savedSlug: string }) {
  const { data, isLoading, error } = useQuery<HostedChatSsoUrlsState>({
    queryKey: ['gateway-hosted-chat-sso', gatewayId, savedSlug],
    queryFn: () => gatewaysApi.getHostedChatSso(gatewayId),
  })

  if (isLoading) return <p className="text-xs text-muted-foreground">Loading sign-in URLs...</p>
  if (error) {
    return (
      <p className="text-xs text-destructive">
        {getApiErrorMessage(error, 'Could not load the URLs to register at your identity provider.')}
      </p>
    )
  }
  if (!data || (data.samlAcsUrls.length === 0 && !data.oidcRedirectUri)) {
    return (
      <p className="text-xs text-muted-foreground">
        Save a subdomain to see the URL to register at your identity provider.
      </p>
    )
  }

  const showSaml = data.protocol !== 'oidc' && data.samlAcsUrls.length > 0
  const showOidc = data.protocol !== 'saml' && !!data.oidcRedirectUri

  return (
    <div className="space-y-3" aria-label="SSO sign-in URLs">
      {data.protocol === null && (
        <p className="text-xs text-muted-foreground">
          SSO is not set up for your organization yet (Settings, SSO). Register the URL for the protocol you
          will use.
        </p>
      )}
      {showSaml && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            SAML: add {data.samlAcsUrls.length > 1 ? 'these ACS URLs' : 'this ACS URL'} to your identity
            provider as {data.samlAcsUrls.length > 1 ? 'additional assertion consumer URLs' : 'an additional assertion consumer URL'} for
            the almyty service provider, exactly as shown:
          </p>
          {data.samlAcsUrls.map((url) => (
            <UrlRow key={url} url={url} label="ACS URL" />
          ))}
        </div>
      )}
      {showOidc && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            OIDC: add this redirect URI to your identity provider's application, exactly as shown:
          </p>
          <UrlRow url={data.oidcRedirectUri!} label="Redirect URI" />
        </div>
      )}
    </div>
  )
}
