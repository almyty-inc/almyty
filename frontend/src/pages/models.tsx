import React, { useEffect } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { KeyRound, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { ModelsCatalog } from '@/components/models/models-catalog'
import { PageIntro } from '@/components/onboarding/page-intro'

/**
 * The Models page is the list of models: every model an agent may call,
 * wherever it runs. There are no tabs and no dialogs. Where a model runs is
 * an attribute of the model (a provider's API, a server you run, your own
 * cloud); Add model is a page (/models/new) that starts by asking exactly
 * that, and each model has a page of its own (/models/:id). Inference
 * providers, the APIs and keys models are called through, have their own
 * page, linked from the header; there is one copy of it, not an embedded
 * second one.
 */
export function ModelsPage() {
  useEffect(() => {
    document.title = 'Models | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const [searchParams] = useSearchParams()

  // Links from before the page lost its tabs, then ?new=1 (command palette).
  const legacyTab = searchParams.get('tab')
  if (legacyTab) {
    const next = new URLSearchParams(searchParams)
    next.delete('tab')
    const qs = next.toString()
    const base = legacyTab === 'providers' ? '/llm-providers' : '/models'
    return <Navigate to={`${base}${qs ? `?${qs}` : ''}`} replace />
  }
  if (searchParams.get('new') === '1') return <Navigate to="/models/new" replace />

  return (
    <div className="space-y-6">
      <PageHeader
        title="Models"
        description="Every model your agents can call, where it runs and what it costs. Use one vendor or several together."
        actions={
          <>
            <Button asChild variant="outline" className="gap-2">
              <Link to="/llm-providers">
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                Inference providers
              </Link>
            </Button>
            <Button asChild className="gap-2">
              <Link to="/models/new">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add model
              </Link>
            </Button>
          </>
        }
      />
      <PageIntro topic="models" />

      <ModelsCatalog />
    </div>
  )
}
