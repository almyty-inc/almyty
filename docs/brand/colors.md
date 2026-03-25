# Almyty Color System

## Violet (primary brand color)

| Step | Hex | Tailwind | Usage |
|------|-----|----------|-------|
| 50 | #f5f3ff | violet-50 | Tinted bg (light) |
| 100 | #ede9fe | violet-100 | Badge bg (light), hover bg (light) |
| 200 | #ddd6fe | violet-200 | |
| 300 | #c4b5fd | violet-300 | Badge text (dark), logo node fill |
| 400 | #a78bfa | violet-400 | Logo top node fill |
| 500 | #8b5cf6 | violet-500 | **PRIMARY (dark)** — buttons, links, focus rings |
| 600 | #7c3aed | violet-600 | **PRIMARY (light)** |
| 700 | #6d28d9 | violet-700 | Badge text (light), hover state (dark) |
| 800 | #5b21b6 | violet-800 | |
| 900 | #4c1d95 | violet-900 | |

## Cyan (accent)

| Step | Hex | Tailwind | Usage |
|------|-----|----------|-------|
| 50 | #ecfeff | cyan-50 | Tinted bg (light) |
| 100 | #cffafe | cyan-100 | Badge bg (light) |
| 200 | #a5f3fc | cyan-200 | |
| 300 | #67e8f9 | cyan-300 | Badge text (dark) |
| 400 | #22d3ee | cyan-400 | **ACCENT (dark)** — highlights, badges, hover |
| 500 | #06b6d4 | cyan-500 | |
| 600 | #0891b2 | cyan-600 | **ACCENT (light)** |
| 700 | #0e7490 | cyan-700 | Badge text (light) |
| 800 | #155e75 | cyan-800 | |
| 900 | #164e63 | cyan-900 | |

## Dark Theme Surfaces (zinc scale)

Every layer MUST be clearly distinguishable.

| Token | Hex | Zinc | Usage |
|-------|-----|------|-------|
| Background | #09090b | zinc-950 | Page bg, deepest layer |
| Card | #18181b | zinc-900 | Cards, panels, popovers |
| Muted | #27272a | zinc-800 | Recessed areas, code blocks, borders |
| Elevated | #3f3f46 | zinc-700 | Hover states, input borders, toggle off |
| Mid | #52525b | zinc-600 | Secondary text (light mode) |
| Subtle | #71717A | zinc-500 | Muted text, placeholders |
| Secondary | #A1A1AA | zinc-400 | Description text, labels |
| Primary text | #FAFAFA | zinc-50 | Body text, headings |

## Light Theme Surfaces

| Token | Hex | Zinc | Usage |
|-------|-----|------|-------|
| Background | #FFFFFF | white | Page bg |
| Card | #FFFFFF | white | Bordered, not tinted |
| Muted | #F4F4F5 | zinc-100 | Recessed areas, code blocks |
| Border | #E4E4E7 | zinc-200 | Card borders, dividers |
| Input border | #D4D4D8 | zinc-300 | Inputs need more contrast than cards |
| Secondary text | #52525b | zinc-600 | |
| Muted text | #71717A | zinc-500 | |
| Primary text | #09090b | zinc-950 | |

## Semantic Colors

| Role | Dark | Light |
|------|------|-------|
| Primary | #8b5cf6 | #7C3AED |
| Accent | #22d3ee | #0891B2 |
| Success | #22c55e | #16a34a |
| Warning | #eab308 | #ca8a04 |
| Destructive | #EF4444 | #DC2626 |

## Protocol Badge Colors

| Protocol | Dark bg | Dark text | Light bg | Light text |
|----------|---------|-----------|----------|------------|
| MCP | violet-500/20 | violet-300 | violet-100 | violet-700 |
| A2A | cyan-500/20 | cyan-300 | cyan-100 | cyan-700 |
| UTCP | emerald-500/20 | emerald-300 | emerald-100 | emerald-700 |
| SOAP | amber-500/20 | amber-300 | amber-100 | amber-700 |
| GraphQL | rose-500/20 | rose-300 | rose-100 | rose-700 |
| REST | blue-500/20 | blue-300 | blue-100 | blue-700 |

## Gradients

```css
/* Primary CTA — one per page max */
.btn-gradient {
  background: linear-gradient(135deg, #8b5cf6 0%, #22d3ee 100%);
}

/* Text gradient — hero headings, logo */
.text-gradient {
  background: linear-gradient(135deg, #8b5cf6 0%, #22d3ee 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

/* Sidebar active border */
.sidebar-active {
  border-left: 2px solid transparent;
  border-image: linear-gradient(to bottom, #8b5cf6, #22d3ee) 1;
}
```

Gradient rules:
- DO: Primary CTA (one per page), hero headings, sidebar active, progress bars, logo
- DON'T: Secondary buttons, form submits, table actions, repeated elements

## Component Contrast Rules

**Toggles:** Off = zinc-700 dark, zinc-200 light. On = violet-500. Thumb = white.

**Cards:** Visible border using --border. Card bg (#18181b) clearly different from page bg (#09090b).

**Text:** Description = zinc-400 (#A1A1AA) dark minimum. Never darker than zinc-500.

**Inputs:** Border --input (zinc-700 dark, zinc-300 light). Focus = violet ring. Placeholder = zinc-500 minimum.

**Buttons:** Primary = solid violet-500, white text. Outline = zinc-800 border dark. Ghost = no bg, violet on hover.

## CSS Variables

### Light (`:root`)

```css
--background: 0 0% 100%;
--foreground: 240 6% 3%;
--card: 0 0% 100%;
--primary: 262 83% 58%;
--secondary: 240 5% 96%;
--muted: 240 5% 96%;
--muted-foreground: 240 4% 46%;
--accent: 189 82% 37%;
--destructive: 0 72% 51%;
--border: 240 6% 90%;
--input: 240 5% 84%;
--ring: 262 83% 58%;
```

### Dark (`.dark`)

```css
--background: 240 6% 3%;
--foreground: 0 0% 98%;
--card: 240 6% 10%;
--primary: 262 83% 66%;
--secondary: 240 5% 17%;
--muted: 240 5% 17%;
--muted-foreground: 240 4% 64%;
--accent: 187 86% 53%;
--destructive: 0 84% 60%;
--border: 240 5% 17%;
--input: 240 4% 26%;
--ring: 262 83% 66%;
```
