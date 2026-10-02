/**
 * A service's logo: the brand's own mark where the `simple-icons` set has
 * it (CC0-1.0; the marks stay their owners' trademarks), else a neutral
 * circle with the first letter of its name. Never an emoji.
 *
 * One map, keyed by what the app already knows a service by: a model
 * provider type (`openai`, `ollama`), or a connector key (`mem0`, `gcp`).
 */
import type { ReactNode } from 'react'
import {
  siAnthropic,
  siBaidu,
  siBytedance,
  siClaude,
  siDeepseek,
  siDigitalocean,
  siGooglecloud,
  siGooglegemini,
  siHuggingface,
  siKimi,
  siMinimax,
  siMistralai,
  siModal,
  siModelcontextprotocol,
  siOllama,
  siOpenapiinitiative,
  siOpenrouter,
  siPerplexity,
  siQwen,
  siTencenthy,
  type SimpleIcon,
} from 'simple-icons'

import { cn } from '@/lib/utils'

/** Keys a logo is looked up by, to the simple-icons mark it is drawn with. */
export const BRAND_ICONS: Record<string, SimpleIcon> = {
  // Model providers (LlmProviderType values)
  anthropic: siAnthropic,
  google: siGooglegemini,
  mistral: siMistralai,
  deepseek: siDeepseek,
  moonshot: siKimi,
  qwen: siQwen,
  minimax: siMinimax,
  qianfan: siBaidu,
  hunyuan: siTencenthy,
  volcengine: siBytedance,
  perplexity: siPerplexity,
  openrouter: siOpenrouter,
  huggingface: siHuggingface,
  vertex_ai: siGooglecloud,
  digitalocean: siDigitalocean,
  modal: siModal,
  ollama: siOllama,
  // Services (connector keys)
  gcp: siGooglecloud,
  'vertex-memory-bank': siGooglecloud,
  'anthropic-memory-tool': siClaude,
  'registry-huggingface': siHuggingface,
  'mcp-custom': siModelcontextprotocol,
  'toolsource-openapi': siOpenapiinitiative,
}

/** A brand colour too dark or too light to read on one of the two themes draws in the text colour instead. */
function readableFill(hex: string): string {
  const n = parseInt(hex, 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance < 0.05 || luminance > 0.8 ? 'currentColor' : `#${hex}`
}


export interface BrandIconProps {
  /** Provider type or connector key. */
  brand: string | null | undefined
  /** The service's name, for the first-letter fallback. */
  name: string
  className?: string
}

export function BrandIcon({ brand, name, className }: BrandIconProps): ReactNode {
  const icon = brand ? BRAND_ICONS[brand] : undefined
  if (icon) {
    return (
      <svg role="img" viewBox="0 0 24 24" aria-hidden className={cn('h-4 w-4 shrink-0', className)} fill={readableFill(icon.hex)} data-brand={brand}>
        <path d={icon.path} />
      </svg>
    )
  }
  const letter = (name.trim().match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase()
  return (
    <span
      aria-hidden
      data-brand-fallback={letter}
      className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 text-[10px] font-semibold leading-none text-muted-foreground', className)}
    >
      {letter}
    </span>
  )
}
