import { useParams } from 'react-router-dom'

import { AddDistributionPicker } from '@/components/agent-apps/add-distribution-picker'
import { WithApp } from '@/components/agent-apps/app-page-loader'

/** /apps/:slug/distributions/new -- choose where the app ships. */
export function AppDistributionNewPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  return <WithApp slug={slug}>{(app) => <AddDistributionPicker app={app} />}</WithApp>
}

export default AppDistributionNewPage
