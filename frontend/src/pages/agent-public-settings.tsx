import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { FormPage } from '@/components/layout/form-page'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { SpendNotice } from '@/components/channels/spend-notice'
import { WithAgent, channelKeys, channelsTabPath } from '@/components/channels/channel-page-loader'
import {
  PublicSettingsFields,
  formFromEffective,
  retentionInvalid,
  settingsFromForm,
  type PublicSettingsForm,
} from '@/components/channels/public-settings-fields'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { getApiErrorMessage } from '@/lib/api-error'
import { agentChannelsApi, type PublicSettings } from '@/lib/agent-channels'
import { useNotifications } from '@/store/app'
import type { Agent } from '@/types'

/**
 * /agents/:id/channels/settings -- the branding and visitor rules every
 * channel of the agent uses unless the channel sets its own.
 */
export function AgentPublicSettingsPage() {
  const { id = '' } = useParams<{ id: string }>()
  return <WithAgent agentId={id}>{(agent) => <Loaded agent={agent} />}</WithAgent>
}

function Loaded({ agent }: { agent: Agent }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: channelKeys.publicSettings(agent.id),
    queryFn: () => agentChannelsApi.publicSettings(agent.id),
  })
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }
  if (isError || !data) return <QueryError error={error} onRetry={() => refetch()} />
  return <PublicSettingsPage agent={agent} settings={data} />
}

function PublicSettingsPage({ agent, settings }: { agent: Agent; settings: PublicSettings }) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [initial, setInitial] = useState<PublicSettingsForm>(() => formFromEffective(settings.effective))
  const [form, setForm] = useState<PublicSettingsForm>(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const guard = useLeaveGuard(dirty)
  const back = channelsTabPath(agent.id)

  const save = useMutation({
    mutationFn: () => agentChannelsApi.updatePublicSettings(agent.id, settingsFromForm(form)),
    onSuccess: (saved) => {
      success('Saved', 'Every channel that uses these settings has them now.')
      const next = formFromEffective(saved.effective)
      setInitial(next)
      setForm(next)
      queryClient.setQueryData(channelKeys.publicSettings(agent.id), saved)
      queryClient.invalidateQueries({ queryKey: channelKeys.list(agent.id) })
      queryClient.invalidateQueries({ queryKey: channelKeys.spend(agent.id) })
    },
    onError: (err: unknown) => errorNotif('Could not save', getApiErrorMessage(err, 'Please try again.')),
  })

  return (
    <FormPage
      title="Branding and visitor rules"
      description={`What people see and who can use ${agent.name}'s channels. A channel can set its own instead.`}
      back={{ to: back, label: agent.name }}
      guard={guard}
      onSubmit={() => save.mutate()}
      submitLabel="Save"
      submitting={save.isPending}
      submitDisabled={!dirty || retentionInvalid(form)}
    >
      <SpendNotice agentId={agent.id} />
      <PublicSettingsFields form={form} onChange={setForm} idPrefix="agent" scope="agent" agentId={agent.id} />
    </FormPage>
  )
}

export default AgentPublicSettingsPage
