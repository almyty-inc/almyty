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
 *
 * A team's connection is the exception no button opens, by design: it
 * serves the team's members and channels set up for that team, never a
 * channel open to everyone. The card says so rather than leaving it to a
 * refused call to find out.
 */
export function AccessCard({ agentId }: { agentId: string }) {
  return (
    <Card data-testid="agent-access-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
          Access
        </CardTitle>
        <CardDescription className="text-xs">
          Your own runs always use your accounts, so nothing here limits you. This is about other people: when someone else writes to it on a channel, it can use only the accounts given to it here. Without access it tells them so instead of guessing.
        </CardDescription>
        <CardDescription className="text-xs" data-testid="access-card-team-rule">
          A team&apos;s connections are the team&apos;s alone: they work on channels set up for that team, not on a channel open to everyone. To use an account there, connect it for the organization and give it to the agent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <WhatItCannotReach
          agentId={agentId}
          intro="Not yet given for other people's messages (your own runs still use them):"
          okText="Other people's messages can use every account its tools and settings use."
        />
      </CardContent>
    </Card>
  )
}
