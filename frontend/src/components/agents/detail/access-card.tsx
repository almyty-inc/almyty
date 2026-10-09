import { KeyRound } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { WhatItCannotReach } from '@/components/agents/builder/capabilities-section'

/**
 * What the agent may use when nobody in particular is behind a run: a
 * message on one of its channels from someone other than its owner, or a
 * run that acts as the agent itself. Then only the connections given to
 * the agent count. Each one it needs and was not given has its own button,
 * right here (agents/agent-identity-reach.ts); nothing is given without
 * that click. A tool it has no access to answers "I don't have access to
 * ..." and the agent says so.
 */
export function AccessCard({ agentId }: { agentId: string }) {
  return (
    <Card data-testid="agent-access-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" aria-hidden />
          Access
        </CardTitle>
        <CardDescription>
          When someone other than you writes to it on a channel, it can use only the accounts given to it here. Without access it says so instead of guessing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <WhatItCannotReach
          agentId={agentId}
          intro="It has not been given these yet:"
          okText="It has been given every account its tools and settings use."
        />
      </CardContent>
    </Card>
  )
}
