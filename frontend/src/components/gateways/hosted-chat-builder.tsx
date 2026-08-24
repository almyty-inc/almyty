import React, { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Copy, ExternalLink, Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { gatewaysApi } from '@/lib/api'
import { useCopy } from '@/lib/clipboard'
import { useNotifications } from '@/store/app'
import {
  HOSTED_CHAT_DEFAULTS,
  canPublishHostedChat,
  hostedChatConfigFrom,
  hostedChatUrl,
  slugError,
  type HostedChatConfig,
} from './hosted-chat-config'

/**
 * The visual builder for a tenant's hosted chat app.
 *
 * The publish rules are shown, not hidden: a public link with no cost
 * cap or no rate limits cannot go live, and this says so before the
 * operator hits save rather than after the API refuses. The same check
 * runs on the backend, which is what actually enforces it; this exists
 * so the reason is visible while it is still fixable.
 */
export interface HostedChatBuilderProps {
  gateway: {
    id: string
    configuration?: Record<string, any> | null
    rateLimits?: { perEndUser?: number | null; perIp?: number | null } | null
    costCapCents?: number | null
  }
  /** Org entitlements, which gate white-label and the sso auth mode. */
  entitlements?: { whiteLabel?: boolean; enterpriseAuth?: boolean }
}

export function HostedChatBuilder({ gateway, entitlements = {} }: HostedChatBuilderProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const copy = useCopy()

  const [form, setForm] = useState<HostedChatConfig>(() =>
    hostedChatConfigFrom(gateway.configuration),
  )
  const [promptDraft, setPromptDraft] = useState('')

  const set = <K extends keyof HostedChatConfig>(key: K, value: HostedChatConfig[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const publishCheck = useMemo(
    () =>
      canPublishHostedChat(form, {
        costCapCents: gateway.costCapCents ?? null,
        perEndUserRateLimit: gateway.rateLimits?.perEndUser ?? null,
        perIpRateLimit: gateway.rateLimits?.perIp ?? null,
        hasWhiteLabel: entitlements.whiteLabel,
        hasEnterpriseAuth: entitlements.enterpriseAuth,
      }),
    [form, gateway.costCapCents, gateway.rateLimits, entitlements],
  )

  const slugMessage = slugError(form.slug)
  const url = form.slug && !slugMessage ? hostedChatUrl(form.slug) : null

  const save = useMutation({
    mutationFn: () =>
      gatewaysApi.update(gateway.id, {
        configuration: { ...(gateway.configuration ?? {}), hostedChat: form },
      }),
    onSuccess: () => {
      success('Chat app saved', 'Your changes are live.')
      queryClient.invalidateQueries({ queryKey: ['gateway', gateway.id] })
    },
    onError: (err: any) =>
      errorNotif('Save failed', err?.response?.data?.message || 'Could not save the chat app.'),
  })

  const addPrompt = () => {
    const prompt = promptDraft.trim()
    if (!prompt || form.suggestedPrompts.length >= 4) return
    set('suggestedPrompts', [...form.suggestedPrompts, prompt])
    setPromptDraft('')
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Address</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="hosted-chat-slug">Subdomain</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="hosted-chat-slug"
                  value={form.slug}
                  onChange={(e) => set('slug', e.target.value.toLowerCase())}
                  placeholder="acme"
                  aria-invalid={!!slugMessage}
                  aria-describedby={slugMessage ? 'hosted-chat-slug-error' : undefined}
                />
                <span className="shrink-0 text-sm text-muted-foreground">
                  .{hostedChatUrl('x').replace('https://x.', '')}
                </span>
              </div>
              {slugMessage ? (
                <p id="hosted-chat-slug-error" className="text-xs text-destructive">
                  {slugMessage}
                </p>
              ) : url ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <code className="truncate">{url}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label="Copy chat app URL"
                    onClick={() => copy(url, 'Chat app URL copied.')}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                  <a href={url} target="_blank" rel="noreferrer" aria-label="Open chat app">
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Appearance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="hosted-chat-name">Name</Label>
              <Input
                id="hosted-chat-name"
                value={form.appName}
                onChange={(e) => set('appName', e.target.value)}
                placeholder="Acme Assistant"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="hosted-chat-color">Brand color</Label>
                <div className="flex items-center gap-2">
                  <input
                    id="hosted-chat-color"
                    type="color"
                    value={form.primaryColor}
                    onChange={(e) => set('primaryColor', e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded border bg-transparent"
                  />
                  <Input
                    value={form.primaryColor}
                    onChange={(e) => set('primaryColor', e.target.value)}
                    aria-label="Brand color hex"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="hosted-chat-theme">Theme</Label>
                <Select value={form.theme} onValueChange={(v) => set('theme', v as any)}>
                  <SelectTrigger id="hosted-chat-theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Match the visitor's system</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hosted-chat-greeting">Greeting</Label>
              <Textarea
                id="hosted-chat-greeting"
                value={form.greeting}
                onChange={(e) => set('greeting', e.target.value)}
                placeholder="How can we help?"
                rows={2}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Suggested prompts</Label>
              <div className="flex flex-wrap gap-2">
                {form.suggestedPrompts.map((prompt) => (
                  <span
                    key={prompt}
                    className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs"
                  >
                    {prompt}
                    <button
                      type="button"
                      aria-label={`Remove ${prompt}`}
                      onClick={() =>
                        set(
                          'suggestedPrompts',
                          form.suggestedPrompts.filter((p) => p !== prompt),
                        )
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
              {form.suggestedPrompts.length < 4 && (
                <div className="flex gap-2">
                  <Input
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addPrompt()
                      }
                    }}
                    placeholder="Track my order"
                    aria-label="New suggested prompt"
                  />
                  <Button type="button" variant="outline" onClick={addPrompt}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Access and disclosure</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="hosted-chat-auth">Who can use it</Label>
              <Select value={form.authMode} onValueChange={(v) => set('authMode', v as any)}>
                <SelectTrigger id="hosted-chat-auth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public_link">Anyone with the link</SelectItem>
                  <SelectItem value="email_otp">Email verification</SelectItem>
                  <SelectItem value="oauth">Sign in with OAuth</SelectItem>
                  <SelectItem value="sso">Enterprise SSO (commercial)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hosted-chat-disclosure">AI disclosure</Label>
              <Input
                id="hosted-chat-disclosure"
                value={form.aiDisclosure ?? ''}
                onChange={(e) => set('aiDisclosure', e.target.value || null)}
                placeholder="You are chatting with an AI assistant."
              />
              <p className="text-xs text-muted-foreground">
                Shown under the composer. Required by the EU AI Act (Art. 50). Leave blank to use
                the default wording.
              </p>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="hosted-chat-white-label">Remove almyty branding</Label>
                <p className="text-xs text-muted-foreground">
                  {entitlements.whiteLabel
                    ? 'Hides the powered-by mark.'
                    : 'Requires a commercial licence.'}
                </p>
              </div>
              <Switch
                id="hosted-chat-white-label"
                checked={form.whiteLabel}
                disabled={!entitlements.whiteLabel}
                onCheckedChange={(v) => set('whiteLabel', v)}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Before it goes live</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {publishCheck.publishable ? (
              <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <Check className="h-4 w-4" />
                Ready to publish.
              </p>
            ) : (
              <ul className="space-y-3" aria-label="Publish blockers">
                {publishCheck.refusals.map((refusal) => (
                  <li key={refusal.code} className="flex gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="text-muted-foreground">{refusal.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Button
          type="button"
          className="w-full"
          disabled={save.isPending || !publishCheck.publishable}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving...' : 'Save chat app'}
        </Button>

        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => setForm(hostedChatConfigFrom(gateway.configuration) ?? HOSTED_CHAT_DEFAULTS)}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}
