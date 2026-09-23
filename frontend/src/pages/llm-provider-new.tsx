import React, { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { cn } from '@/lib/utils'
import { AddInferenceProviderForm } from '@/components/llm-providers/add-inference-provider-form'

/** Add an inference provider on a page of its own: linkable, and Back works. */
export function LlmProviderNewPage() {
  const navigate = useNavigate()
  useEffect(() => {
    document.title = 'Add inference provider | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link to="/llm-providers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Inference providers
        </Link>
        <h1 className={cn("mt-1", DETAIL_TITLE_CLASSES)}>Add inference provider</h1>
        <p className="text-muted-foreground">An API that serves models: OpenAI, Anthropic, Groq, a server you run, and more. Keys are encrypted at rest.</p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <AddInferenceProviderForm onCreated={(p) => navigate(`/llm-providers/${p.id}`)} onCancel={() => navigate('/llm-providers')} />
        </CardContent>
      </Card>
    </div>
  )
}
