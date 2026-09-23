import { useParams, useSearchParams } from 'react-router-dom'

import { WithApp, WithDistribution } from '@/components/agent-apps/app-page-loader'
import { SigningCredentialForm } from '@/components/agent-apps/signing-credential-form'

/**
 * /apps/:slug/distributions/:target/signing/new?kind=apple|authenticode
 * -- add the certificate this distribution's builds are signed with.
 */
export function AppSigningNewPage() {
  const { slug = '', target } = useParams<{ slug: string; target: string }>()
  const [searchParams] = useSearchParams()
  const kind = searchParams.get('kind') === 'authenticode' ? 'authenticode' : 'apple'

  return (
    <WithApp slug={slug}>
      {(app) => (
        <WithDistribution app={app} target={target}>
          {(distribution) => (
            <SigningCredentialForm
              slug={app.slug}
              appName={app.branding?.appName || app.name}
              target={distribution.target}
              kind={kind}
            />
          )}
        </WithDistribution>
      )}
    </WithApp>
  )
}

export default AppSigningNewPage
