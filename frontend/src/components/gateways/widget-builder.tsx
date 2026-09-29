/**
 * WidgetBuilder: the website widget place of an app. The embed snippet,
 * where the widget sits on the page, and a live preview.
 *
 * The widget's look (colour, name, greeting, theme, the almyty mark and
 * the AI disclosure line) is the app's branding, read by the public
 * widget-config endpoint on every request (widgetConfigFor in the
 * backend), so it is edited once, in the app's settings, and not here.
 * What is the widget's own is where it sits and which launcher icon it
 * shows: `gateway.configuration.widget`, saved as a MERGE so everything
 * else on the gateway is left alone.
 *
 * Live preview: an iframe (srcdoc) loads the REAL widget.js from the API
 * for this gateway, so the preview is exactly what the site embeds. The
 * only preview affordance is a fetch shim inside the iframe that answers
 * the widget's own /widget-config request with the app look plus the
 * current (unsaved) placement.
 */
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Field, FormSection } from '@/components/layout/form-page'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { gatewaysApi, getApiBaseUrl } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { buildWidgetEmbedSnippet } from '@/components/gateways/widget-embed'
import { getApiErrorMessage } from '@/lib/api-error'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

/** Where the widget sits and how its launcher looks: the widget's own settings. */
export const widgetPlacementSchema = z.object({
  position: z.enum(['bottom-right', 'bottom-left']),
  launcherIcon: z.enum(['chat', 'help', 'spark']),
})

export type WidgetPlacement = z.infer<typeof widgetPlacementSchema>

export const WIDGET_PLACEMENT_DEFAULTS: WidgetPlacement = {
  position: 'bottom-right',
  launcherIcon: 'spark',
}

/** Mirrors WIDGET_DEFAULT_AI_DISCLOSURE on the backend (widget-script.ts). */
const DEFAULT_AI_DISCLOSURE = 'You are chatting with an AI assistant.'
const DEFAULT_COLOR = '#8b5cf6'
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** The saved placement, field by field, with the defaults for anything missing or invalid. */
export function widgetPlacementFrom(configuration: Record<string, any> | null | undefined): WidgetPlacement {
  const raw = configuration?.widget
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const position = widgetPlacementSchema.shape.position.safeParse(stored.position)
  const launcherIcon = widgetPlacementSchema.shape.launcherIcon.safeParse(stored.launcherIcon)
  return {
    position: position.success ? position.data : WIDGET_PLACEMENT_DEFAULTS.position,
    launcherIcon: launcherIcon.success ? launcherIcon.data : WIDGET_PLACEMENT_DEFAULTS.launcherIcon,
  }
}

export interface WidgetOwnerApp {
  name: string
  branding?: {
    appName?: string
    primaryColor?: string
    greeting?: string
    theme?: 'dark' | 'light' | 'auto'
    aiDisclosure?: string | null
    whiteLabel?: boolean
  } | null
}

export interface WidgetLook {
  primaryColor: string
  title: string
  greeting: string
  theme: 'dark' | 'light' | 'auto'
  poweredBy: boolean
  aiDisclosure: string
}

/** The look an app-owned widget answers with; mirrors widgetConfigFor in the backend. */
export function widgetLookFromApp(app: WidgetOwnerApp): WidgetLook {
  const b = app.branding ?? {}
  const color = typeof b.primaryColor === 'string' && HEX_COLOR.test(b.primaryColor.trim()) ? b.primaryColor.trim().toLowerCase() : DEFAULT_COLOR
  const title = (b.appName || app.name || '').trim().slice(0, 60) || 'Chat with us'
  return {
    primaryColor: color,
    title,
    greeting: (b.greeting ?? '').trim().slice(0, 300),
    theme: b.theme === 'dark' || b.theme === 'light' ? b.theme : 'auto',
    poweredBy: !b.whiteLabel,
    aiDisclosure:
      typeof b.aiDisclosure === 'string' && b.aiDisclosure.trim() ? b.aiDisclosure.trim().slice(0, 200) : DEFAULT_AI_DISCLOSURE,
  }
}

/**
 * srcdoc for the live preview iframe. Loads the real widget.js from the API
 * and shims only the widget-config fetch so unsaved values render. The
 * config travels as JSON in an inert script tag (with `<` escaped), never
 * interpolated into markup or code.
 */
export function buildPreviewSrcDoc(scriptSrc: string, config: WidgetPlacement & WidgetLook): string {
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
  /** The app the widget is a place of, whose look it shows. */
  app: WidgetOwnerApp
}

export function WidgetBuilder({ gateway, app }: WidgetBuilderProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const saved = widgetPlacementFrom(gateway.configuration)
  const form = useForm<WidgetPlacement>({
    resolver: zodResolver(widgetPlacementSchema),
    values: saved,
  })

  const saveMutation = useMutation({
    mutationFn: (placement: WidgetPlacement) => {
      // Merge, never replace: the configuration also carries the app link
      // and whatever else the gateway holds.
      const configuration = gateway.configuration ?? {}
      const widget = configuration.widget && typeof configuration.widget === 'object' ? configuration.widget : {}
      return gatewaysApi.update(gateway.id, {
        configuration: { ...configuration, widget: { ...widget, ...placement } },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', gateway.id] })
      success('Saved', 'Websites with the widget pick this up within a minute.')
    },
    onError: (err: unknown) => {
      errorNotif('Could not save', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // A moved widget not yet saved asks before a navigation throws it away.
  // A save refetches the gateway, which resets the form to it.
  const guard = useLeaveGuard(form.formState.isDirty && !saveMutation.isPending)

  const apiBase = getApiBaseUrl()
  const scriptSrc = `${apiBase}/gateways/${gateway.id}/widget.js`
  const embedSnippet = buildWidgetEmbedSnippet(apiBase, gateway.id)
  const look = widgetLookFromApp(app)

  // Debounced preview: re-render the iframe once the placement settles.
  const watched = form.watch()
  const watchedKey = JSON.stringify(watched)
  const [previewPlacement, setPreviewPlacement] = useState<WidgetPlacement>(saved)
  useEffect(() => {
    const timer = setTimeout(() => {
      const parsed = widgetPlacementSchema.safeParse(watched)
      if (parsed.success) setPreviewPlacement(parsed.data)
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedKey])

  const lookKey = JSON.stringify(look)
  const previewSrcDoc = useMemo(
    () => buildPreviewSrcDoc(scriptSrc, { ...look, ...previewPlacement }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scriptSrc, lookKey, previewPlacement],
  )

  return (
    <>
      <FormSection
        title="Add it to your site"
        description="Paste this line before the closing body tag of every page that should show the chat."
      >
        <CopyField id="widget-embed-snippet" value={embedSnippet} label="Embed snippet" />
      </FormSection>

      <FormSection
        title="How it looks"
        description="The colour, name, greeting and theme come from the app's settings, so it looks the same everywhere."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <form className="space-y-4" onSubmit={form.handleSubmit((data) => saveMutation.mutate(data))}>
            <Field id="widget-position" label="Position">
              <Select
                value={form.watch('position')}
                onValueChange={(v) => form.setValue('position', v as WidgetPlacement['position'], { shouldDirty: true })}
              >
                <SelectTrigger id="widget-position" aria-label="Position">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bottom-right">Bottom right</SelectItem>
                  <SelectItem value="bottom-left">Bottom left</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field id="widget-launcher-icon" label="Launcher icon">
              <Select
                value={form.watch('launcherIcon')}
                onValueChange={(v) => form.setValue('launcherIcon', v as WidgetPlacement['launcherIcon'], { shouldDirty: true })}
              >
                <SelectTrigger id="widget-launcher-icon" aria-label="Launcher icon">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="spark">Spark</SelectItem>
                  <SelectItem value="chat">Chat bubble</SelectItem>
                  <SelectItem value="help">Question mark</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Button type="submit" variant="outline" disabled={!form.formState.isDirty || saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </form>

          <div>
            <Label>Preview</Label>
            <iframe
              title="Chat widget live preview"
              sandbox="allow-scripts"
              srcDoc={previewSrcDoc}
              className="mt-1 h-[480px] w-full rounded-lg border bg-muted/30"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The widget exactly as your site will load it. Sending messages may be blocked inside the preview.
            </p>
          </div>
        </div>
      </FormSection>
      {guard.element}
    </>
  )
}
