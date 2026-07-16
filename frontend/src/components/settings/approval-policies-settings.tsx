/**
 * ApprovalPoliciesSettings — admin surface for the EE approval-policy engine.
 *
 * This manages the POLICIES that decide *when* an approval is required and *who*
 * must sign off. It is distinct from the /approvals queue, which is where those
 * pending requests are actually decided. Gated behind the `approval_policy`
 * entitlement (Business tier); without it we show an UpgradePrompt rather than
 * letting the admin click through to the backend's 402.
 *
 * Mirrors the SsoSettings gating pattern.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Plus, Pencil, Trash2 } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { EntitlementGate } from '@/components/entitlement-gate'
import { UpgradePrompt } from '@/components/plan-indicator'
import { useNotifications } from '@/store/app'
import {
  approvalPoliciesApi,
  type ApprovalPolicy,
  type UpsertApprovalPolicy,
} from '@/lib/api'
import { ApprovalPolicyDialog } from './approval-policy-dialog'

export function ApprovalPoliciesSettings() {
  return (
    <EntitlementGate
      feature="approval_policy"
      mode="lock"
      fallback={
        <UpgradePrompt
          feature="approval_policy"
          title="Approval Policies"
          description="Require multi-step, conditional, or quorum sign-off before an agent runs a sensitive action — e.g. refunds over a threshold need finance and a manager."
        />
      }
    >
      <ApprovalPoliciesManager />
    </EntitlementGate>
  )
}

function summarizeMatch(policy: ApprovalPolicy): string {
  if (!policy.match || policy.match.length === 0) return 'Every request'
  return policy.match
    .map((c) => {
      const v = Array.isArray(c.value) ? `[${c.value.join(', ')}]` : String(c.value)
      return `${c.attr} ${c.op} ${v}`
    })
    .join(' AND ')
}

function ApprovalPoliciesManager() {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ApprovalPolicy | null>(null)
  const [deleting, setDeleting] = useState<ApprovalPolicy | null>(null)

  const { data: policies, isLoading } = useQuery<ApprovalPolicy[]>({
    queryKey: ['approval-policies'],
    queryFn: () => approvalPoliciesApi.list(),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['approval-policies'] })

  const createMutation = useMutation({
    mutationFn: (data: UpsertApprovalPolicy) => approvalPoliciesApi.create(data),
    onSuccess: async () => {
      success('Policy created', 'The approval policy is now active.')
      setDialogOpen(false)
      setEditing(null)
      await invalidate()
    },
    onError: (err: any) =>
      error('Failed to create policy', err.response?.data?.message || 'Please try again.'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<UpsertApprovalPolicy> }) =>
      approvalPoliciesApi.update(id, data),
    onSuccess: async () => {
      success('Policy updated', 'Changes saved.')
      setDialogOpen(false)
      setEditing(null)
      await invalidate()
    },
    onError: (err: any) =>
      error('Failed to update policy', err.response?.data?.message || 'Please try again.'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => approvalPoliciesApi.delete(id),
    onSuccess: async () => {
      success('Policy deleted', 'The approval policy has been removed.')
      setDeleting(null)
      await invalidate()
    },
    onError: (err: any) =>
      error('Failed to delete policy', err.response?.data?.message || 'Please try again.'),
  })

  const handleSubmit = (data: UpsertApprovalPolicy) => {
    if (editing) {
      updateMutation.mutate({ id: editing.id, data })
    } else {
      createMutation.mutate(data)
    }
  }

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEdit = (policy: ApprovalPolicy) => {
    setEditing(policy)
    setDialogOpen(true)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" /> Approval Policies
            </CardTitle>
            <CardDescription>
              Decide when an approval is required and who must sign off. Requests that
              don&apos;t match any policy fall back to single-gate approval. Decide
              pending requests in the Approvals queue.
            </CardDescription>
          </div>
          <Button onClick={openCreate} className="shrink-0">
            <Plus className="h-4 w-4 mr-1" /> New Policy
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground">
              Loading approval policies...
            </div>
          ) : !policies || policies.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-muted-foreground">No approval policies yet.</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create one to require sign-off on sensitive agent actions.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>When it applies</TableHead>
                  <TableHead className="text-center">Steps</TableHead>
                  <TableHead className="text-center">Priority</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {policies.map((policy) => (
                  <TableRow key={policy.id}>
                    <TableCell className="font-medium">
                      {policy.name}
                      {policy.description && (
                        <p className="text-xs text-muted-foreground font-normal">
                          {policy.description}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                      {summarizeMatch(policy)}
                    </TableCell>
                    <TableCell className="text-center">{policy.steps?.length ?? 0}</TableCell>
                    <TableCell className="text-center">{policy.priority}</TableCell>
                    <TableCell className="text-center">
                      {policy.enabled ? (
                        <Badge variant="outline" className="border-primary/40 text-primary">
                          Enabled
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          Disabled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${policy.name}`}
                          onClick={() => openEdit(policy)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${policy.name}`}
                          onClick={() => setDeleting(policy)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ApprovalPolicyDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditing(null)
        }}
        policy={editing}
        isSaving={createMutation.isPending || updateMutation.isPending}
        onSubmit={handleSubmit}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete approval policy?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `"${deleting.name}" will be removed. Requests it governed will fall back to single-gate approval. This cannot be undone.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
