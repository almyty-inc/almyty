## almyty design system — how to build with it

These are almyty's real compiled React components (on `window.AlmytyDS.*`). Compose them as-is and
style your own layout glue with Tailwind utility classes. The design system ships its tokens and
component CSS via `styles.css` — it's already loaded, so components are styled on render.

### Setup / wrapping
- **No provider needed** for almost everything — components style themselves from CSS variables +
  Tailwind utilities in `styles.css`. Render them inside any container.
- **Fonts:** headings use `font-heading` (Manrope), body uses `font-body` / `font-sans` (DM Sans),
  code uses `font-mono` (JetBrains Mono). Body text defaults to DM Sans.
- **Dark mode:** put `class="dark"` on a parent element. Every token has a light and dark value —
  never hard-code hex; use the token classes below so both themes stay correct.

### Styling idiom — Tailwind utilities + semantic token classes
Tailwind v4 / shadcn-style system. Prefer the **semantic token classes** over raw colors:
- Surfaces & text: `bg-background` `text-foreground` `bg-card` `bg-muted` `text-muted-foreground`
  `bg-primary text-primary-foreground` `bg-secondary text-secondary-foreground`
  `bg-destructive text-destructive-foreground` `bg-accent`
- Borders & focus: `border` `border-border` `border-input` `ring-ring` `rounded-md` / `rounded-lg`
- **Brand accents** (use sparingly): violet scale `violet-50…violet-900` (primary `violet-500`,
  #8b5cf6); cyan scale `cyan-50…cyan-900` (accent `cyan-400`, #22d3ee — use `cyan-*`, not `accent-*`).
  Primary CTAs are violet, not indigo. At most one violet→cyan gradient CTA per screen.
- Spacing/sizing: standard Tailwind scale (`gap-4`, `p-6`, `h-10`, …).

### almyty-specific components
- `<ProtocolBadge protocol="mcp|a2a|utcp|skills|soap|graphql|rest|slack|discord|…" />` renders the
  canonical protocol color (MCP=violet, A2A=cyan, UTCP/Skills=emerald, SOAP=amber, GraphQL=rose,
  REST=blue). Use it anywhere a protocol/interface is shown.
- `<Badge variant="default|secondary|outline|success|warning|destructive" />` for status pills.
- `<StatCard icon={Icon} label value subtitle />` for dashboard metrics.
- `<EmptyState icon title description action secondaryAction />` for empty list/detail states.

### Where the truth lives
- `styles.css` and its `@import` closure (incl. `_ds_bundle.css`) — all tokens + component CSS.
- Each component's `components/<group>/<Name>/<Name>.d.ts` (prop contract) and `<Name>.prompt.md`
  (usage). Read these before composing a component you haven't used.

### One idiomatic example
```tsx
// Components are provided by the almyty design system (window.AlmytyDS.*).
<div className="bg-background text-foreground font-sans p-6 space-y-4">
  <div className="grid grid-cols-3 gap-4">
    <StatCard icon={Activity} label="Executions (24h)" value="3,420" subtitle="+12% vs yesterday" />
    <StatCard icon={Bot} label="Active agents" value={12} />
    <StatCard icon={Network} label="Gateways" value={6} />
  </div>
  <Card>
    <CardContent className="p-6 flex items-center justify-between">
      <span className="text-sm text-muted-foreground">Gateway protocol</span>
      <ProtocolBadge protocol="mcp" />
    </CardContent>
  </Card>
  <div className="flex gap-2">
    <Button>Deploy agent</Button>
    <Button variant="outline">Cancel</Button>
  </div>
</div>
```
