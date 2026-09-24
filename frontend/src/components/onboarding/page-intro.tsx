import { Link } from 'react-router-dom'
import { Info, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useOrganizationStore } from '@/store/organization'
import { PAGE_INTROS, type PageIntroTopic } from './page-intros'
import { useOnboarding, useOnboardingPreferences } from './use-onboarding'

interface PageIntroProps {
  topic: PageIntroTopic
}

/**
 * One line under a page's header saying what the page is and what to do
 * first, with a link to the guide. Closing it is remembered per user on
 * the server, and the guide page can bring every intro back.
 *
 * Renders nothing until the user's preferences have loaded, so a line
 * someone closed never flashes back in on the next visit.
 */
export function PageIntro({ topic }: PageIntroProps) {
  const { currentOrganization } = useOrganizationStore()
  const { data } = useOnboarding(currentOrganization?.id)
  const { dismissIntro } = useOnboardingPreferences()

  if (!data) return null
  if (data.dismissedIntros?.includes(topic)) return null
  // Optimistic: once the close is sent, the line goes.
  if (dismissIntro.isPending && dismissIntro.variables === topic) return null

  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-violet-500/20 bg-violet-500/5 px-4 py-3 text-sm"
      data-testid={`page-intro-${topic}`}
      role="note"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-muted-foreground">
        {PAGE_INTROS[topic].text}{' '}
        <Link
          to="/guide"
          className="whitespace-nowrap font-medium text-violet-600 hover:underline dark:text-violet-400"
        >
          Open the guide
        </Link>
      </p>
      <Button
        variant="ghost"
        size="icon"
        className="-my-1 h-7 w-7 shrink-0 text-muted-foreground"
        aria-label="Hide this tip"
        onClick={() => dismissIntro.mutate(topic)}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
