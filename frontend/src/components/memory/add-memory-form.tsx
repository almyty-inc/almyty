/**
 * /memories/new -- write one memory (or one document) to the org's
 * canonical store. It routes to whichever backend the workspace scope is
 * configured for.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { memoriesApi, type MemoryMode, type MemoryTier } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'

export const MEMORY_TIERS: MemoryTier[] = ['short', 'project', 'long', 'shared']

const EMPTY_DRAFT = {
  content: '',
  tier: 'short' as MemoryTier,
  tags: '',
  mode: 'memory' as MemoryMode,
  source_uri: '',
}

export function AddMemoryForm() {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const notify = useNotifications()
  const qc = useQueryClient()
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const dirty = draft.content !== '' || draft.tags !== '' || draft.source_uri !== ''
  const guard = useLeaveGuard(dirty)

  const putMut = useMutation({
    mutationFn: () =>
      memoriesApi.put({
        mode: draft.mode,
        scope: { scope_type: 'workspace', scope_id: orgId! },
        content: draft.content,
        tier: draft.mode === 'memory' ? draft.tier : undefined,
        tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
        source_uri: draft.mode === 'document' ? draft.source_uri : undefined,
        source_version: draft.mode === 'document' ? 1 : undefined,
        provenance: {
          agent_id: null, session_id: null, collab_id: null,
          model: null, provider: null, tool_chain: ['ui_put'],
          created_by: 'user', source_backend: 'almyty-native',
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', 'list', orgId] })
      // The soft-cap warning list is a sibling key, not a descendant,
      // and storing is exactly what trips a soft cap.
      qc.invalidateQueries({ queryKey: ['memories', 'softcap-warnings', orgId] })
      notify.success('Memory stored')
      guard.leave('/memories')
    },
    onError: (err: any) => notify.error('Store failed', err?.message ?? String(err)),
  })

  const submit = () => {
    const next: Record<string, string> = {}
    if (!orgId) next.content = 'Select an organization first.'
    else if (!draft.content.trim()) next.content = 'Write what the memory should hold.'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    putMut.mutate()
  }

  return (
    <FormPage
      title="Add memory"
      description="Writes to the canonical store. Routes to whichever backend the scope is configured for."
      back={{ to: '/memories', label: 'Memory' }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Store"
      submitting={putMut.isPending}
      width="narrow"
    >
      <FormSection>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="memory-mode" label="Mode" hint="A memory is a fact or preference; a document is a body of text with a source.">
            <Select value={draft.mode} onValueChange={(v) => setDraft({ ...draft, mode: v as MemoryMode })}>
              <SelectTrigger id="memory-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="memory">memory</SelectItem>
                <SelectItem value="document">document</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {draft.mode === 'memory' ? (
            <Field id="memory-tier" label="Scope">
              <Select value={draft.tier} onValueChange={(v) => setDraft({ ...draft, tier: v as MemoryTier })}>
                <SelectTrigger id="memory-tier"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MEMORY_TIERS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <Field id="memory-source-uri" label="Source URI">
              <Input
                placeholder="https://… or almyty:file/…"
                value={draft.source_uri}
                onChange={(e) => setDraft({ ...draft, source_uri: e.target.value })}
              />
            </Field>
          )}
        </div>
        <Field id="memory-content" label="Content" required error={errors.content}>
          <Textarea
            rows={6}
            placeholder="The fact, preference, decision, or document body."
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
        </Field>
        <Field id="memory-tags" label="Tags" hint="Comma-separated.">
          <Input
            placeholder="user-pref, infrastructure"
            value={draft.tags}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
          />
        </Field>
      </FormSection>
    </FormPage>
  )
}
