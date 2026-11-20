/**
 * "Delete run" on an opened run: removes one finished run of the agent,
 * after a "Delete run?" confirm. Offered to people who may manage the
 * agent; a run still going cannot be deleted, so the button waits for it
 * to finish. The server decides either way (DELETE /agents/:id/runs/:runId).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { presentationForRun } from '@/lib/run-status'
import { useNotifications } from '@/store/app'

export function DeleteRunButton({
  agentId,
  runId,
  status,
  onDeleted,
}: {
  agentId: string
  runId: string
  status: string
  onDeleted: (runId: string) => void
}) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const { confirm, dialog } = useConfirm()
  const finished = presentationForRun(status).terminal

  const remove = useMutation({
    mutationFn: () => agentsApi.deleteRun(agentId, runId),
    onSuccess: async () => {
      success('Run deleted')
      onDeleted(runId)
      await Promise.all(
        ['agent-runs', 'agent-latest-run', 'agent'].map((key) => queryClient.invalidateQueries({ queryKey: [key, agentId] })),
      )
    },
    onError: (err: unknown) => {
      errorNotif('Could not delete the run', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const onClick = async () => {
    const ok = await confirm({
      title: 'Delete run?',
      description: 'This deletes the run, its steps and the tool calls it made. It cannot be undone.',
      confirmLabel: 'Delete run',
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 text-destructive hover:text-destructive"
        disabled={!finished || remove.isPending}
        title={finished ? undefined : 'A run can be deleted once it has finished'}
        onClick={() => void onClick()}
      >
        {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
        Delete run
      </Button>
      {dialog}
    </>
  )
}
