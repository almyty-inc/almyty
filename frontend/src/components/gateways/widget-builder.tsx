/**
 * WidgetBuilder: the website widget channel of an agent. The embed snippet,
 * where the widget sits on the page, and a live preview.
 *
 * The widget's look (colour, name, greeting, theme, the almyty mark and
 * the AI disclosure line) is the agent's branding, or the channel's own,
 * read by the public widget-config endpoint on every request
 * (widgetConfigFor in the backend), so it is edited under branding and
 * visitor rules, and not here.
 * What is the widget's own is where it sits and which launcher icon it
 * shows: `gateway.configuration.widget`, edited here and saved with the
 * channel page as a MERGE so everything else on the gateway is left alone.
 *
 * Live preview: an iframe (srcdoc) loads the REAL widget.js from the API
 * for this gateway, so the preview is exactly what the site embeds. The
 * only preview affordance is a fetch shim inside the iframe that answers
 * the widget's own /widget-config request with that look plus the
 * current (unsaved) placement.
 */
import { useEffect, useMemo, useState } from 'react'
import * as z from 'zod'

import { Field, FormSection } from '@/components/layout/form-page'
import { CopyField } from '@/components/ui/copy-field'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { getApiBaseUrl } from '@/lib/api'
import { buildWidgetEmbedSnippet } from '@/components/gateways/widget-embed'

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

/** The look a channel's widget answers with; mirrors widgetConfigFor in the backend. */
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
  /** The channel's resolved branding (the agent's, or its own), whose look it shows. */
  app: WidgetOwnerApp
  /** Where it sits, as edited on the page; saved with the page. */
  placement: WidgetPlacement
  onPlacementChange: (placement: WidgetPlacement) => void
}

export function WidgetBuilder({ gateway, app, placement, onPlacementChange }: WidgetBuilderProps) {
  const apiBase = getApiBaseUrl()
  const scriptSrc = `${apiBase}/gateways/${gateway.id}/widget.js`
  const embedSnippet = buildWidgetEmbedSnippet(apiBase, gateway.id)
  const look = widgetLookFromApp(app)

  // Debounced preview: re-render the iframe once the placement settles.
  const placementKey = JSON.stringify(placement)
  const [previewPlacement, setPreviewPlacement] = useState<WidgetPlacement>(placement)
  useEffect(() => {
    const timer = setTimeout(() => setPreviewPlacement(placement), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placementKey])

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
        description="The colour, name, greeting and theme come from the branding and visitor rules, so it looks the same everywhere."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Field id="widget-position" label="Position">
              <Select
                value={placement.position}
                onValueChange={(v) => onPlacementChange({ ...placement, position: v as WidgetPlacement['position'] })}
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
                value={placement.launcherIcon}
                onValueChange={(v) => onPlacementChange({ ...placement, launcherIcon: v as WidgetPlacement['launcherIcon'] })}
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
          </div>

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
    </>
  )
}
