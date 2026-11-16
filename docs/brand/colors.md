# almyty colour system

Design system v1 (approved white revision). The source of truth is the
design-system package, `tokens.json` in
`/Users/frane/Documents/Codex/2026-10-27/referenced-chatgpt-conversation-this-is-an/outputs/almyty-design-system`;
its generated `tokens.css` is copied verbatim into
`frontend/src/styles/tokens.css`. Regenerate in the package and copy
again rather than editing values in the app.

Every value below is a semantic token (`--am-*`). The shadcn names the
components read (`--primary`, `--border`, `--ring`, ...) are bridged to
them in the same file, so components follow without per-page colours.

## Primary blue

| Token | Light | Dark | Tailwind |
|-------|-------|------|----------|
| Action primary | #1469EC | #7AB5FF | `bg-primary`, `text-primary` |
| Primary hover | #105BD0 | #9CC8FF | `hover:bg-primary-hover` |
| Primary pressed | #0F4FB3 | #5AA0FA | `active:bg-primary-pressed` |
| On primary | #FFFFFF | #0D2440 | `text-primary-foreground` |
| Focus ring | #1469EC | #7AB5FF | `ring-ring` (2px, 2px offset) |

Hover and pressed are explicit colours, never an opacity of the base.

Blue scale (`brand-*` in Tailwind): 50 #EFF6FF, 100 #DBEAFF, 200 #B8D5FF,
300 #86B9FF, 400 #4C96FF, 500 #2775F7, 600 #1469EC, 700 #105BD0,
800 #0F4FB3, 900 #103E85.

## Surfaces and text

| Token | Light | Dark | Tailwind / use |
|-------|-------|------|----------------|
| Canvas (page) | #FFFFFF | #101827 | `bg-background` |
| Surround | #F6F9FD | #131E30 | `bg-surround`: the app shell around the white working panel |
| Raised (card, popover) | #FFFFFF | #162235 | `bg-card` |
| Inset (muted) | #EFF3F8 | #1D2B42 | `bg-muted` |
| Hover surface | #F1F6FD | #203149 | `--am-surface-hover` |
| Text primary | #141E30 | #EDF3FC | `text-foreground` |
| Text secondary | #5C6980 | #ACBAD0 | `text-muted-foreground` |
| Placeholder | #69778E | #A3B2CA | `--am-text-placeholder` |
| Rule (subtle border) | #E6EBF2 | #354760 | `border` |
| Control border | #7B8BA3 | #6C83A3 | `border-input`: fields and outline buttons |
| Selection surface | #EBF3FF | #203A5F | `bg-selection`, shadcn `--accent` |
| Selection text | #185FCA | #B7D5FF | `text-selection-foreground` |

Dark surfaces still layer upward: page < card < inset in lightness.

## Status pairs

Status is always a foreground and a background together, plus a label or
icon. Colour never carries a state alone. A category (protocol, provider)
is not a status.

| Tone | Light text / surface | Dark text / surface | Meaning |
|------|----------------------|---------------------|---------|
| Info | #185FCA / #EBF3FF | #B6D3FF / #1D3657 | running, information, selection |
| Success | #276C52 / #EAF9F1 | #86DBB4 / #15392E | confirmed completion |
| Warning | #8E651F / #FFF6E5 | #F0CF85 / #463719 | waiting, review |
| Danger | #B72E35 / #FFF0F0 | #FFB3BC / #47232A | failure, destructive intent |
| Neutral | #4E5F77 / #EFF3F8 | #BECCE0 / #26364C | draft, queued, cancelled, sleeping, unknown |

Tailwind: `text-info bg-info-subtle border-info-border` (and `success`,
`warning`, `danger`); the `tone-*` utilities set both halves at once.
Run lifecycle states map through `frontend/src/lib/run-status.ts`.

## Gradients

Accents only: the original mark, short strips, progress fills, a hero
underline and the product field behind a showcased surface. Never on a
button, a paragraph, a data cell or an editor; text stays on an opaque
surface.

| Name | Stops | Utility |
|------|-------|---------|
| Accent | #2775F7 -> #26C5CF (65%) -> #85E5BA | `bg-accent-gradient` |
| Product field (light) | #EAF1FF -> #E5F8FF (45%) -> #E6FCF1 | `bg-product-field` |
| Product field (dark) | #172D53 -> #173B4B (45%) -> #17382E | `bg-product-field` |

Default actions are solid primary. No page has a gradient call to action.

## Protocol and schema badges

Identity, not readiness. Each keeps a distinct, readable hue with a light
and a dark half (`components/ui/protocol-badge.tsx`,
`components/ui/api-type-badge.tsx`).

| Kind | Light bg / text | Dark bg / text |
|------|-----------------|----------------|
| MCP | brand-50 / brand-700 | brand-500/15 / brand-200 |
| A2A | teal-50 / teal-700 | teal-500/15 / teal-300 |
| UTCP, Skills | emerald-50 / emerald-700 | emerald-500/15 / emerald-300 |
| SOAP | amber-50 / amber-800 | amber-500/15 / amber-300 |
| GraphQL | rose-50 / rose-700 | rose-500/15 / rose-300 |
| REST, OpenAPI | slate-100 / slate-700 | slate-500/20 / slate-300 |
| Protobuf, gRPC | fuchsia-50 / fuchsia-700 | fuchsia-500/15 / fuchsia-300 |

A second category beside the brand blue (a runner tool, an idle machine,
a provider hop) uses teal with a light and a dark half.

## Charts

Six series tokens, `chart-1` to `chart-6`: light #1469EC, #0D807D, #B56316,
#B43A55, #5969AA, #64748B; dark #7AB5FF, #68D5CB, #F2BE8D, #F89BB1,
#B8BFF5, #BCCBDD. Label series or give a legend; a hue never implies success.

## Component rules

**Buttons:** 40px default (36px compact on desktop, 44px touch target).
Primary is solid blue with explicit hover and pressed colours. Outline:
control border, field fill, field-hover on hover. Ghost: no fill, the hover
surface on hover. Destructive is never the universal primary.

**Fields:** control border (`--input`), field fill (`--field`), 2px focus
ring with a 2px offset, distinct read-only and disabled fills, a danger
border when invalid. Inputs on a touch pointer use 16px text.

**Navigation:** the selected item is the selection surface with blue text;
hover uses the hover surface. Page and detail tabs are underlined; a
segmented control is for local views only.

**Shell:** the sidebar sits on the surround; the working panel is white
(canvas) with a subtle rule. In dark mode the page is the canvas token.

**Cards:** 12px radius, a subtle rule, a nearly flat panel shadow. No
nested card chrome.
