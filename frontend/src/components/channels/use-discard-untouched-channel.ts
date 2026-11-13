import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'

import { agentChannelsApi, type AgentChannel } from '@/lib/agent-channels'
import { channelKeys } from './channel-page-loader'

/**
 * What Add channel hands the channel page it opens: the channels it just
 * added (the one picked, and a web chat added for a desktop app to open).
 */
export interface JustAddedChannelState {
  justAdded?: { ids: string[] }
}

/**
 * Picking a kind of channel adds it at once, so its page has an address and
 * a callback URL to show. Backing out of that page without saving anything
 * left a draft behind ("Telegram · Not answering yet") that nobody meant to
 * keep. This takes it away again: a channel added just now, still a draft,
 * with nothing saved, published or built on its page, is deleted when the
 * page closes.
 *
 * Returns `keep`, called once anything on the page is saved: from then on
 * the channel stays, also if the page is reached again from history.
 */
export function useDiscardUntouchedChannel(agentId: string, channel: Pick<AgentChannel, 'id' | 'status'>): () => void {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const added = (location.state as JustAddedChannelState | null)?.justAdded
  const ids = added?.ids?.includes(channel.id) ? added.ids : null
  const idsKey = ids ? ids.join(',') : ''

  const kept = useRef(false)
  // React mounts a component twice in development; the delete waits a tick
  // and goes ahead only if the page did not come straight back.
  const alive = useRef(false)
  const status = useRef(channel.status)
  useEffect(() => {
    status.current = channel.status
  }, [channel.status])

  useEffect(() => {
    alive.current = true
    if (!idsKey) return
    const discard = idsKey.split(',')
    return () => {
      alive.current = false
      setTimeout(() => {
        if (alive.current || kept.current || status.current !== 'draft') return
        queryClient.setQueryData<AgentChannel[]>(channelKeys.list(agentId), (old) => old?.filter((c) => !discard.includes(c.id)))
        void Promise.allSettled(discard.map((id) => agentChannelsApi.remove(agentId, id))).then(() =>
          queryClient.invalidateQueries({ queryKey: channelKeys.list(agentId) }),
        )
      }, 0)
    }
  }, [agentId, idsKey, queryClient])

  const pathname = location.pathname
  return useCallback(() => {
    if (kept.current) return
    kept.current = true
    // Forget it was just added, so a return to this page from history
    // never deletes a channel someone saved.
    if (idsKey) navigate(pathname, { replace: true, state: null })
  }, [idsKey, navigate, pathname])
}
