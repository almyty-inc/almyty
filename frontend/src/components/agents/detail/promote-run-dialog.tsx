/**
 * "Promote to skill" dialog — turns a completed agent run into a reusable
 * PromotedSkill (the promote step of run -> verify -> promote -> replay).
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'

import { promotedSkillsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'

interface PromoteRunDialogProps {
  runId: string
}

export function PromoteRunDialog({ runId }: PromoteRunDialogProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const reset = () => {
    setName('')
    setDescription('')
  }

  const mutation = useMutation({
    mutationFn: () =>
      promotedSkillsApi.promote({
        runId,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      success('Skill promoted', 'The run is now a reusable skill.')
      queryClient.invalidateQueries({ queryKey: ['promoted-skills'] })
      setOpen(false)
      reset()
    },
    onError: (e: any) => {
      errorNotif('Promotion failed', e?.response?.data?.message || e?.message || 'Could not promote run')
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Sparkles className="h-3.5 w-3.5" />
          Promote to skill
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote run to skill</DialogTitle>
          <DialogDescription>
            Distill this successful run into a reusable skill other agents can follow. Leave fields
            blank to derive them from the agent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              value={name}
              maxLength={120}
              placeholder="e.g. Quarterly revenue report"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
              value={description}
              maxLength={500}
              placeholder="When should an agent reach for this skill?"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="gap-1.5">
            {mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Promote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
