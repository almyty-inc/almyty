/**
 * WidgetBuilder — per-gateway chat widget customization with live preview.
 *
 * Edits `gateway.configuration.widget` (presentation only: color, position,
 * launcher icon, greeting, title, theme, poweredBy) and saves it through the
 * existing gateways update API as a MERGE into the configuration jsonb —
 * channel credentials and the aiDisclosure setting stored alongside it are
 * never touched.
 *
 * Live preview: an iframe (srcdoc) loads the REAL widget.js from the API for
 * the actual gateway id, so the preview is exactly what customers embed. The
 * only preview affordance is a fetch shim inside the iframe that answers the
 * widget's own /widget-config request with the CURRENT (unsaved) form values
 * — the script, DOM, and styling are the production ones. The srcdoc also
 * auto-opens the panel so the preview is immediately meaningful.
 *
 * The aiDisclosure line shown in the preview is a passthrough of the
 * channel-level `configuration.aiDisclosure` setting (EU AI Act), mirroring
 * the server-side sanitizer — it is displayed here but edited elsewhere.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, MessageSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

import { gatewaysApi, getApiBaseUrl } from '@/lib/api'
import { useCopy } from '@/lib/clipboard'
import { useNotifications } from '@/store/app'
import { buildWidgetEmbedSnippet } from '@/components/agents/detail/channel-setup'

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** Mirrors the backend sanitizer caps (widget-script.ts). */
export const widgetConfigSchema = z.object({
  primaryColor: z
    .string()
    .trim()
    .regex(HEX_COLOR, 'Must be a hex color like #8b5cf6'),
  position: z.enum(['bottom-right', 'bottom-left']),
  launcherIcon: z.enum(['chat', 'help', 'spark']),
  greeting: z.string().max(300, 'Greeting must be 300 characters or fewer'),
  title: z.string().min(1, 'Title is required').max(60, 'Title must be 60 characters or fewer'),
  theme: z.enum(['dark', 'light', 'auto']),
  poweredBy: z.boolean(),
})

export type WidgetConfigForm = z.infer<typeof widgetConfigSchema>

export const WIDGET_CONFIG_FORM_DEFAULTS: WidgetConfigForm = {
  primaryColor: '#8b5cf6',
  position: 'bottom-right',
  launcherIcon: 'spark',
  greeting: '',
  title: 'Chat with us',
  theme: 'auto',
  poweredBy: true,
}

/** Mirrors ChannelGatewayService.DEFAULT_AI_DISCLOSURE on the backend. */
const DEFAULT_AI_DISCLOSURE = 'You are chatting with an AI assistant.'

/** Initial form values from a gateway's saved configuration.widget. */
export function widgetConfigFromGateway(
  configuration: Record<string, any> | null | undefined,
): WidgetConfigForm {
  const raw = configuration?.widget
  const merged = {
    ...WIDGET_CONFIG_FORM_DEFAULTS,
    ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
  }
  const parsed = widgetConfigSchema.safeParse(merged)
  return parsed.success ? parsed.data : { ...WIDGET_CONFIG_FORM_DEFAULTS }
}

/** Channel-level aiDisclosure passthrough (same semantics as the backend). */
export function aiDisclosureText(
  configuration: Record<string, any> | null | undefined,
): string | null {
  const setting = configuration?.aiDisclosure
  if (setting === true) return DEFAULT_AI_DISCLOSURE
  if (typeof setting === 'string' && setting.trim()) return setting.trim().slice(0, 200)
  return null
}

/**
 * srcdoc for the live preview iframe. Loads the real widget.js from the API
 * and shims only the widget-config fetch so unsaved form values render. The
 * config travels as JSON in an inert script tag (with `<` escaped) — never
 * interpolated into markup or code.
 */
export function buildPreviewSrcDoc(
  scriptSrc: string,
  config: WidgetConfigForm & { aiDisclosure: string | null },
): string {
  const payload = JSON.stringify({ success: true, data: config }).replace(/</g, '\\u003c')
  const bg = config.theme === 'dark' ? '#09090b' : '#f4f4f5'
  return [
    '<!doctype html>',
    '<html>',
    `<head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:${bg}}</style></head>`,
    '<body>',
    `<script type="application/json" id="almyty-preview-config">${payload}</scr` + 'ipt>',
    '<script>',
    '(function () {',
    "  var payload = document.getElementById('almyty-preview-config').textContent;",
    '  var orig = window.fetch;',
    '  window.fetch = function (input) {',
    "    var url = typeof input === 'string' ? input : (input && input.url) || '';",
    "    if (url.indexOf('/widget-config') !== -1) {",
    "      return Promise.resolve(new Response(payload, { headers: { 'Content-Type': 'application/json' } }));",
    '    }',
    '    return orig.apply(window, arguments);',
    '  };',
    "  window.addEventListener('load', function () {",
    '    setTimeout(function () {',
    "      var b = document.querySelector('.almyty-widget-bubble');",
    '      if (b) b.click();',
    '    }, 150);',
    '  });',
    '})();',
    '</scr' + 'ipt>',
    `<script src="${scriptSrc}"></scr` + 'ipt>',
    '</body>',
    '</html>',
  ].join('\n')
}

export interface WidgetBuilderProps {
  gateway: {
    id: string
    name?: string
    type: string
    configuration?: Record<string, any> | null
  }
}

export function WidgetBuilder({ gateway }: WidgetBuilderProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const copy = useCopy()

  const form = useForm<WidgetConfigForm>({
    resolver: zodResolver(widgetConfigSchema),
    values: widgetConfigFromGateway(gateway.configuration),
  })

  const saveMutation = useMutation({
    mutationFn: (widget: WidgetConfigForm) =>
      // Merge, never replace: the configuration jsonb also carries the
      // channel-level settings (e.g. aiDisclosure) for this gateway.
      gatewaysApi.update(gateway.id, {
        configuration: { ...(gateway.configuration ?? {}), widget },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', gateway.id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Widget saved', 'Embedded widgets pick up the new look within a minute.')
    },
    onError: (err: any) => {
      errorNotif('Failed to save widget', err?.response?.data?.message || 'Please try again.')
    },
  })

  const apiBase = getApiBaseUrl()
  const scriptSrc = `${apiBase}/gateways/${gateway.id}/widget.js`
  const embedSnippet = buildWidgetEmbedSnippet(apiBase, gateway.id)
  const disclosure = aiDisclosureText(gateway.configuration)

  // Debounced live preview: re-render the iframe with the current form
  // values whenever they settle into a valid state; invalid interim
  // states keep the last good preview.
  const watched = form.watch()
  const watchedKey = JSON.stringify(watched)
  const [previewConfig, setPreviewConfig] = useState<WidgetConfigForm>(() =>
    widgetConfigFromGateway(gateway.configuration),
  )
  useEffect(() => {
    const timer = setTimeout(() => {
      const parsed = widgetConfigSchema.safeParse(watched)
      if (parsed.success) setPreviewConfig(parsed.data)
    }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedKey])

  const previewSrcDoc = useMemo(
    () => buildPreviewSrcDoc(scriptSrc, { ...previewConfig, aiDisclosure: disclosure }),
    [scriptSrc, previewConfig, disclosure],
  )

  const errors = form.formState.errors
  const primaryColor = form.watch('primaryColor')
  const colorPickerValue = HEX_COLOR.test(primaryColor?.trim() ?? '')
    ? expandHex(primaryColor.trim())
    : '#8b5cf6'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" aria-hidden="true" />
          Widget builder
        </CardTitle>
        <CardDescription>
          Customize how the embedded chat widget looks on your site. The preview loads the
          real widget script for this gateway.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-2">
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((data) => saveMutation.mutate(data))}
          >
            <div>
              <Label htmlFor="widget-title">Title</Label>
              <Input
                id="widget-title"
                maxLength={60}
                placeholder="Chat with us"
                {...form.register('title')}
              />
              {errors.title && (
                <p className="text-sm text-red-500 mt-1">{errors.title.message}</p>
              )}
            </div>

            <div>
              <Label htmlFor="widget-primary-color">Primary color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick primary color"
                  className="h-9 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1"
                  value={colorPickerValue}
                  onChange={(e) =>
                    form.setValue('primaryColor', e.target.value, {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
                />
                <Input
                  id="widget-primary-color"
                  placeholder="#8b5cf6"
                  maxLength={7}
                  {...form.register('primaryColor')}
                />
              </div>
              {errors.primaryColor && (
                <p className="text-sm text-red-500 mt-1">{errors.primaryColor.message}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="widget-position">Position</Label>
                <Select
                  value={form.watch('position')}
                  onValueChange={(v) =>
                    form.setValue('position', v as WidgetConfigForm['position'], {
                      shouldDirty: true,
                    })
                  }
                >
                  <SelectTrigger id="widget-position">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bottom-right">Bottom right</SelectItem>
                    <SelectItem value="bottom-left">Bottom left</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="widget-launcher-icon">Launcher icon</Label>
                <Select
                  value={form.watch('launcherIcon')}
                  onValueChange={(v) =>
                    form.setValue('launcherIcon', v as WidgetConfigForm['launcherIcon'], {
                      shouldDirty: true,
                    })
                  }
                >
                  <SelectTrigger id="widget-launcher-icon">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="spark">Spark</SelectItem>
                    <SelectItem value="chat">Chat bubble</SelectItem>
                    <SelectItem value="help">Question mark</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label htmlFor="widget-theme">Theme</Label>
              <Select
                value={form.watch('theme')}
                onValueChange={(v) =>
                  form.setValue('theme', v as WidgetConfigForm['theme'], { shouldDirty: true })
                }
              >
                <SelectTrigger id="widget-theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (match visitor)</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="widget-greeting">Greeting</Label>
              <Textarea
                id="widget-greeting"
                rows={2}
                maxLength={300}
                placeholder="Shown as the first message when a visitor opens the widget"
                {...form.register('greeting')}
              />
              {errors.greeting && (
                <p className="text-sm text-red-500 mt-1">{errors.greeting.message}</p>
              )}
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="widget-powered-by">Show "powered by almyty"</Label>
                <p className="text-xs text-muted-foreground">
                  A small footer line inside the widget panel.
                </p>
              </div>
              <Switch
                id="widget-powered-by"
                checked={form.watch('poweredBy')}
                onCheckedChange={(v) =>
                  form.setValue('poweredBy', v, { shouldDirty: true })
                }
              />
            </div>

            {disclosure && (
              <p className="text-xs text-muted-foreground">
                AI disclosure (from the channel setting): "{disclosure}"
              </p>
            )}

            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving…' : 'Save widget'}
            </Button>

            <div className="pt-2">
              <Label htmlFor="widget-embed-snippet">Embed snippet</Label>
              <div className="mt-1 flex items-start gap-2">
                <pre
                  id="widget-embed-snippet"
                  className="flex-1 overflow-x-auto rounded-md border bg-muted p-2 font-mono text-xs"
                >
                  {embedSnippet}
                </pre>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Copy embed snippet"
                  onClick={() => copy(embedSnippet, 'Embed snippet')}
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Paste this before the closing body tag of any page.
              </p>
            </div>
          </form>

          <div>
            <Label>Live preview</Label>
            <iframe
              title="Chat widget live preview"
              sandbox="allow-scripts"
              srcDoc={previewSrcDoc}
              className="mt-1 h-[560px] w-full rounded-lg border bg-muted/30"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The preview runs the exact widget.js this gateway serves; unsaved changes are
              applied on top. Sending messages may be blocked by the preview sandbox.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** #abc -> #aabbcc for the native color input (which requires 6 digits). */
function expandHex(hex: string): string {
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase()
  }
  return hex.toLowerCase()
}
